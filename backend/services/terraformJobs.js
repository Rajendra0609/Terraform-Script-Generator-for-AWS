'use strict';
/**
 * Per-type job runners for the async execution queue.
 *
 * This is the SINGLE place that knows how to actually run a terraform
 * operation end-to-end (CLI execution + security scan + policy gating +
 * DB side-effects). Both the synchronous Redis-fallback path and the real
 * BullMQ worker path in jobQueue.js call into dispatch() via the same
 * processJob callback (see server.js), so behaviour never diverges between
 * dev (no Redis — runs inline) and production (Redis-backed async worker).
 *
 * Before this module existed, routes/terraform.js called runPlan/runValidate
 * directly (with checkov + network-lint + policy gating inlined in the
 * route), while server.js's queue processor called the bare runX()
 * functions with none of that — so anything actually enqueued through
 * jobQueue.enqueue() silently lost checkov findings and the "block on
 * critical" policy gate. Routing everything through dispatch() fixes that.
 */
const { runFmt, runValidate, runPlan, runApply } = require('../terraform/runner');
const { runCheckov } = require('./checkov');
const { lintNetworkRules } = require('../utils/sanitize');
const db = require('../db/connection');
const { evaluateAllPolicies } = require('./opaEval');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fmtJob(data, logFn) {
  return runFmt(data.hcl, logFn, data.mode);
}

async function validateJob(data, logFn) {
  const networkWarnings = lintNetworkRules(data.hcl);
  const [validateResult, checkovResult] = await Promise.all([
    runValidate(data.hcl, logFn, data.mode),
    runCheckov(data.hcl),
  ]);

  if (data.projectId && UUID_RE.test(data.projectId)) {
    db.query(
      'INSERT INTO validation_logs (project_id, is_valid, diagnostics) VALUES ($1,$2,$3)',
      [data.projectId, validateResult.valid ?? false, JSON.stringify(validateResult.diagnostics || [])]
    ).catch(() => {}); // fire-and-forget, same as the old inline route logic
  }

  return { ...validateResult, networkWarnings, checkov: checkovResult };
}

/**
 * Run the Checkov critical-finding gate and the OPA policy-as-code gate,
 * and return a single, consistent verdict. Shared by planJob() and
 * applyJob() so the two code paths can never silently diverge again — see
 * the SECURITY FIX comment in applyJob() for why that divergence mattered.
 *
 * @param {string} hcl
 * @param {object} ctx
 * @param {string} ctx.phase          'plan' | 'apply' — used only for messaging
 * @param {string|null} ctx.projectId
 * @param {string|null} ctx.userId
 * @param {object} ctx.planResult     terraform plan output to feed OPA context
 * @param {object} [ctx.checkovResult] pre-computed Checkov result, if the
 *                                     caller already ran it (planJob runs
 *                                     Checkov in parallel with the plan) —
 *                                     avoids scanning the same HCL twice.
 */
async function runSecurityGates(hcl, ctx) {
  const { phase, projectId, userId, planResult } = ctx;
  const checkovResult = ctx.checkovResult || await runCheckov(hcl);

  // ── Checkov critical gate ────────────────────────────────────────────────
  const criticalFindings = (checkovResult.findings || []).filter(f => f.severity === 'CRITICAL');
  const blockOnCritical  = process.env.BLOCK_PLAN_ON_CRITICAL !== 'false';
  if (criticalFindings.length > 0 && blockOnCritical) {
    // Alert the project's team — in-app notification bell (source of truth)
    // plus a best-effort email. Fire-and-forget: a notification failure must
    // never delay or break the plan/apply response the user is waiting on.
    if (projectId && UUID_RE.test(projectId)) {
      (async () => {
        try {
          const { rows } = await db.query('SELECT name FROM projects WHERE id=$1', [projectId]);
          const projectName = rows[0]?.name;
          const { notifyProjectMembers } = require('./notify');
          const { sendCheckovCriticalAlert } = require('./mailer');
          await notifyProjectMembers(projectId, {
            type: 'checkov.critical',
            title: `${criticalFindings.length} critical finding(s) blocked a${phase === 'apply' ? 'n apply' : ' plan'}`,
            body: `${criticalFindings.slice(0, 3).map(f => f.check_id || f.id).join(', ')}${criticalFindings.length > 3 ? '…' : ''}`,
            link: `/builder/${projectId}?tab=security`,
            actor_id: userId || null,
          }, {
            email: (toEmail) => sendCheckovCriticalAlert(toEmail, {
              projectId, projectName, findings: criticalFindings,
            }),
          });
        } catch (_) { /* best-effort — never block the response on this */ }
      })().catch(() => {});
    }

    return {
      blocked: true,
      blocked_by: 'checkov',
      message: `${phase === 'apply' ? 'Apply' : 'Plan'} blocked: ${criticalFindings.length} CRITICAL security finding(s) detected`,
      checkov: checkovResult,
    };
  }

  // ── OPA policy-as-code gate ──────────────────────────────────────────────
  // Evaluate all enabled policy rules against plan output + project resources.
  if (projectId && UUID_RE.test(projectId)) {
    try {
      const { rows: resources } = await db.query(
        'SELECT service_type, resource_name, config FROM resources WHERE project_id=$1',
        [projectId]
      ).catch(() => ({ rows: [] }));

      const policyResult = await evaluateAllPolicies(db, planResult, resources);

      if (!policyResult.passed) {
        const failedPolicies = policyResult.results.filter(r => !r.passed);

        if (policyResult.blocked) {
          // blocks_plan is the only gating flag the schema has today; a
          // policy severe enough to gate a plan is at least as severe when
          // gating a real apply, so it's reused for both phases rather than
          // adding a parallel blocks_apply column.
          const msgs = failedPolicies
            .filter(r => r.policy.blocks_plan && !r.passed)
            .flatMap(r => r.violations);

          return {
            blocked: true,
            blocked_by: 'policy',
            message: `${phase === 'apply' ? 'Apply' : 'Plan'} blocked by ${failedPolicies.filter(r => r.policy.blocks_plan).length} governance policy violation(s)`,
            policy_violations: msgs,
            policy_results:    policyResult.results,
            checkov: checkovResult,
          };
        }

        // Non-blocking violations — attach as warnings, allow to proceed
        return {
          blocked: false,
          checkov: checkovResult,
          policy_results:  policyResult.results,
          policy_warnings: failedPolicies.flatMap(r => r.violations),
        };
      }

      return { blocked: false, checkov: checkovResult, policy_results: policyResult.results };
    } catch (policyErr) {
      // Policy evaluation failure is non-fatal — log and continue
      console.warn('[terraformJobs] OPA eval error (non-fatal):', policyErr.message);
    }
  }

  return { blocked: false, checkov: checkovResult };
}

/**
 * Fetch-and-decrypt AWS credentials for a job, right before they're needed.
 *
 * SECURITY FIX (critical — C-06): routes/terraform.js used to decrypt
 * credentials at REQUEST time and put the plaintext result straight into
 * the object passed to jobQueue.enqueue() — which BullMQ then serializes
 * into a Redis job (queue.add()). With default removeOnComplete:100 /
 * removeOnFail:200, that meant a rolling window of up to 300 sets of
 * plaintext AWS credentials sitting in Redis, made worse by Redis
 * previously having no auth at all (see docker-compose.yml). Now the route
 * only enqueues a `useRealCredentials` boolean + `userId`; this function is
 * the ONLY place that actually decrypts, and it does so here — inside the
 * worker, immediately before the credentials are used by runPlan()/
 * runApply() — so the plaintext exists only in this process's memory for
 * the duration of the call and is never part of any serialized job payload.
 */
async function loadJobCredentials(data) {
  if (!data.useRealCredentials) return null;
  const { getDecryptedAwsCredentials } = require('../utils/awsCrypto');
  return getDecryptedAwsCredentials(data.userId) || null;
}

async function planJob(data, logFn) {
  const networkWarnings = lintNetworkRules(data.hcl);
  const awsCredentials = await loadJobCredentials(data);
  const [planResult, checkovResult] = await Promise.all([
    runPlan(data.hcl, logFn, awsCredentials, data.mode),
    runCheckov(data.hcl),
  ]);

  const gate = await runSecurityGates(data.hcl, {
    projectId: data.projectId,
    userId:    data.userId,
    planResult,
    phase:     'plan',
    checkovResult, // reuse the checkov run above instead of scanning twice
  });

  if (gate.blocked) {
    return {
      success: false,
      blocked: true,
      blocked_by: gate.blocked_by,
      message: gate.message,
      checkov: gate.checkov,
      policy_violations: gate.policy_violations,
      policy_results:    gate.policy_results,
      networkWarnings,
      resource_changes: [],
      summary: { create_count: 0, update_count: 0, delete_count: 0, total: 0 },
    };
  }

  return {
    ...planResult,
    networkWarnings,
    checkov: gate.checkov,
    policy_results:  gate.policy_results,
    policy_warnings: gate.policy_warnings,
  };
}

async function applyJob(data, logFn) {
  // Defense in depth: the route handler already rejects apply requests
  // without saved AWS credentials before ever enqueuing a job, but a future
  // caller of jobQueue.enqueue({type:'apply', ...}) that skips that check
  // must not be able to "apply" with mock/no credentials.
  //
  // SECURITY FIX (C-06): decrypt here, inside the worker, rather than
  // trusting a pre-decrypted value on `data` (see loadJobCredentials() /
  // the routes/terraform.js comment for the full writeup of why credentials
  // must never travel through the job payload).
  const awsCredentials = await loadJobCredentials({ ...data, useRealCredentials: true });
  if (!awsCredentials) {
    return {
      success: false,
      message: 'AWS credentials are required to apply. Connect an AWS account under Settings → AWS Credentials first.',
      resource_changes: [],
    };
  }

  // SECURITY FIX (critical — "governance/security-scan gate is a structural
  // no-op ... wrong execution order"): applyJob() used to call runApply()
  // directly with NO checkov scan and NO OPA policy evaluation at all — the
  // gate that blocks a plan on CRITICAL findings or a blocking policy only
  // existed in planJob(), a completely separate, non-mutating code path a
  // caller could simply skip. A user with `deployer` role and saved AWS
  // credentials could apply arbitrary insecure infrastructure (open SSH to
  // 0.0.0.0/0, unencrypted storage, anything) with zero governance checks,
  // as long as they called /apply instead of /plan first.
  //
  // Fix: run a dry-run plan first — exactly what `terraform apply` does
  // internally anyway when not given a saved plan file — and gate on ITS
  // checkov + OPA results before ever calling runApply(). This mirrors
  // planJob()'s gate exactly (same shared runSecurityGates()) rather than a
  // parallel, divergent copy.
  const preApplyPlan = await runPlan(data.hcl, logFn, awsCredentials, data.mode);

  const gate = await runSecurityGates(data.hcl, {
    projectId:  data.projectId,
    userId:     data.userId,
    planResult: preApplyPlan,
    phase:      'apply',
  });

  if (gate.blocked) {
    return {
      success: false,
      blocked: true,
      blocked_by: gate.blocked_by,
      message: gate.message,
      checkov: gate.checkov,
      policy_violations: gate.policy_violations,
      policy_results:    gate.policy_results,
      resource_changes: [],
    };
  }

  const applyResult = await runApply(data.hcl, logFn, awsCredentials, data.mode);
  return { ...applyResult, checkov: gate.checkov, policy_results: gate.policy_results };
}

async function dispatch(data, logFn) {
  switch (data.type) {
    case 'fmt':      return fmtJob(data, logFn);
    case 'validate': return validateJob(data, logFn);
    case 'plan':     return planJob(data, logFn);
    case 'apply':    return applyJob(data, logFn);
    default:
      throw new Error(`Unknown job type: ${data.type}`);
  }
}

/**
 * Wraps dispatch() with execution_jobs lifecycle persistence
 * (queued → running → succeeded/failed). This is passed as the
 * `processJob` callback to jobQueue.initQueue() AND used directly by any
 * route that calls jobQueue.enqueue() — there is exactly one code path
 * that knows how to run a job and record its status, so the BullMQ-worker
 * path and the no-Redis synchronous-fallback path can never disagree about
 * what happened to a given execution_jobs row.
 */
async function dispatchAndPersist(data, logFn) {
  const { jobId } = data;
  // OBSERVABILITY: single choke point for every job type (fmt/validate/
  // plan/apply), reached from both the BullMQ-worker path and the
  // no-Redis synchronous fallback (see this function's own doc comment
  // above) — recording metrics here means every execution path is covered
  // by one line rather than needing to be wired into each separately.
  const { terraformJobDuration, terraformJobsTotal } = require('../observability/metrics');
  const metricsStart = process.hrtime.bigint();

  if (jobId) {
    await db.query(
      "UPDATE execution_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
      [jobId]
    ).catch((e) => console.warn('[terraformJobs] failed to mark running:', e.message));
  }

  try {
    const result = await dispatch(data, logFn);
    const failed = !!(result && (result.success === false || result.valid === false || result.blocked === true));
    terraformJobDuration.observe(
      { job_type: data.type, status: failed ? 'failed' : 'succeeded' },
      Number(process.hrtime.bigint() - metricsStart) / 1e9
    );
    terraformJobsTotal.inc({ job_type: data.type, status: failed ? 'failed' : 'succeeded' });

    if (jobId) {
      await db.query(
        `UPDATE execution_jobs
            SET status = $2, plan_summary = $3, checkov_summary = $4, error = $5, finished_at = NOW()
          WHERE id = $1`,
        [
          jobId,
          failed ? 'failed' : 'succeeded',
          JSON.stringify(result?.summary || {}),
          JSON.stringify(result?.checkov || {}),
          failed ? (result?.message || result?.error || 'Job failed') : null,
        ]
      ).catch((e) => console.warn('[terraformJobs] failed to mark finished:', e.message));

      // Apply can run 5–15 minutes — long enough that a user watching the
      // live log in ApplyStatusPanel may well have navigated away before it
      // finishes. Notify the team so completion isn't only visible to
      // whoever happened to keep the tab open.
      if (data.type === 'apply' && data.projectId && UUID_RE.test(data.projectId)) {
        (async () => {
          try {
            const { notifyProjectMembers } = require('./notify');
            await notifyProjectMembers(data.projectId, {
              type: failed ? 'apply.failed' : 'apply.succeeded',
              title: failed ? '💥 Apply failed' : '🚀 Apply succeeded',
              body: failed ? (result?.message || result?.error || 'Job failed') : 'Infrastructure changes were applied successfully.',
              link: `/builder/${data.projectId}?tab=apply`,
              actor_id: data.userId || null,
            });
          } catch (_) { /* best-effort */ }
        })().catch(() => {});
      }
    }

    return result;
  } catch (err) {
    // OBSERVABILITY: dispatch() itself threw (as opposed to returning a
    // {success:false} result, handled above) — record this distinctly as
    // "errored" so a spike in unhandled exceptions is visible separately
    // from ordinary plan/apply failures or policy blocks in Grafana.
    terraformJobDuration.observe(
      { job_type: data.type, status: 'errored' },
      Number(process.hrtime.bigint() - metricsStart) / 1e9
    );
    terraformJobsTotal.inc({ job_type: data.type, status: 'errored' });

    if (jobId) {
      await db.query(
        "UPDATE execution_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1",
        [jobId, err.message]
      ).catch((e) => console.warn('[terraformJobs] failed to mark failed:', e.message));
    }
    throw err;
  }
}

module.exports = { dispatch, dispatchAndPersist, fmtJob, validateJob, planJob, applyJob };
