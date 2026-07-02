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

async function planJob(data, logFn) {
  const networkWarnings = lintNetworkRules(data.hcl);
  const [planResult, checkovResult] = await Promise.all([
    runPlan(data.hcl, logFn, data.awsCredentials || null, data.mode),
    runCheckov(data.hcl),
  ]);

  // ── Phase 2: Checkov critical gate ───────────────────────────────────────
  const criticalFindings = (checkovResult.findings || []).filter(f => f.severity === 'CRITICAL');
  const blockOnCritical  = process.env.BLOCK_PLAN_ON_CRITICAL !== 'false';
  if (criticalFindings.length > 0 && blockOnCritical) {
    // Alert the project's team — in-app notification bell (source of truth)
    // plus a best-effort email. Fire-and-forget: a notification failure must
    // never delay or break the plan response the user is waiting on.
    if (data.projectId && UUID_RE.test(data.projectId)) {
      (async () => {
        try {
          const { rows } = await db.query('SELECT name FROM projects WHERE id=$1', [data.projectId]);
          const projectName = rows[0]?.name;
          const { notifyProjectMembers } = require('./notify');
          const { sendCheckovCriticalAlert } = require('./mailer');
          await notifyProjectMembers(data.projectId, {
            type: 'checkov.critical',
            title: `${criticalFindings.length} critical finding(s) blocked a plan`,
            body: `${criticalFindings.slice(0, 3).map(f => f.check_id || f.id).join(', ')}${criticalFindings.length > 3 ? '…' : ''}`,
            link: `/builder/${data.projectId}?tab=security`,
            actor_id: data.userId || null,
          }, {
            email: (toEmail) => sendCheckovCriticalAlert(toEmail, {
              projectId: data.projectId,
              projectName,
              findings: criticalFindings,
            }),
          });
        } catch (_) { /* best-effort — never block the plan response on this */ }
      })().catch(() => {});
    }

    return {
      success: false,
      blocked: true,
      message: `Plan blocked: ${criticalFindings.length} CRITICAL security finding(s) detected`,
      checkov: checkovResult,
      networkWarnings,
      resource_changes: [],
      summary: { create_count: 0, update_count: 0, delete_count: 0, total: 0 },
    };
  }

  // ── Phase 2: OPA policy-as-code gate ─────────────────────────────────────
  // Evaluate all enabled policy rules against plan output + project resources.
  // If any blocking policy fires, surface it as a blocked plan (not a crash).
  if (data.projectId && UUID_RE.test(data.projectId)) {
    try {
      // Fetch current resources for this project to feed into policy context
      const { rows: resources } = await db.query(
        'SELECT service_type, resource_name, config FROM resources WHERE project_id=$1',
        [data.projectId]
      ).catch(() => ({ rows: [] }));

      const policyResult = await evaluateAllPolicies(db, planResult, resources);

      if (!policyResult.passed) {
        const failedPolicies = policyResult.results.filter(r => !r.passed);

        if (policyResult.blocked) {
          // At least one blocking policy fired — stop the plan
          const msgs = failedPolicies
            .filter(r => r.policy.blocks_plan && !r.passed)
            .flatMap(r => r.violations);

          return {
            success: false,
            blocked: true,
            blocked_by: 'policy',
            message: `Plan blocked by ${failedPolicies.filter(r => r.policy.blocks_plan).length} governance policy violation(s)`,
            policy_violations: msgs,
            policy_results:    policyResult.results,
            checkov: checkovResult,
            networkWarnings,
            resource_changes: [],
            summary: { create_count: 0, update_count: 0, delete_count: 0, total: 0 },
          };
        }

        // Non-blocking violations — attach as warnings but allow plan to proceed
        return {
          ...planResult,
          networkWarnings,
          checkov: checkovResult,
          policy_results:    policyResult.results,
          policy_warnings:   failedPolicies.flatMap(r => r.violations),
        };
      }

      // All policies passed
      return { ...planResult, networkWarnings, checkov: checkovResult, policy_results: policyResult.results };
    } catch (policyErr) {
      // Policy evaluation failure is non-fatal — log and continue
      console.warn('[terraformJobs] OPA eval error (non-fatal):', policyErr.message);
    }
  }

  return { ...planResult, networkWarnings, checkov: checkovResult };
}

async function applyJob(data, logFn) {
  // Defense in depth: the route handler already rejects apply requests
  // without saved AWS credentials before ever enqueuing a job, but a future
  // caller of jobQueue.enqueue({type:'apply', ...}) that skips that check
  // must not be able to "apply" with mock/no credentials.
  if (!data.awsCredentials) {
    return {
      success: false,
      message: 'AWS credentials are required to apply. Connect an AWS account under Settings → AWS Credentials first.',
      resource_changes: [],
    };
  }
  return runApply(data.hcl, logFn, data.awsCredentials, data.mode);
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

  if (jobId) {
    await db.query(
      "UPDATE execution_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
      [jobId]
    ).catch((e) => console.warn('[terraformJobs] failed to mark running:', e.message));
  }

  try {
    const result = await dispatch(data, logFn);

    if (jobId) {
      const failed = !!(result && (result.success === false || result.valid === false || result.blocked === true));
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
