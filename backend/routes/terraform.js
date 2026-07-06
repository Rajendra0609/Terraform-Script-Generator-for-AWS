'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { runFmt, runInit } = require('../terraform/runner');
const { runCheckov }   = require('../services/checkov');
const { runInfracost } = require('../services/infracost');
const { stripHtml, detectSecrets, detectDangerousConstructs, lintNetworkRules, hasMarkup } = require('../utils/sanitize');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const db = require('../db/connection');
const { enqueue, getJobStatus } = require('../services/jobQueue');
const { dispatchAndPersist } = require('../services/terraformJobs');
const { authoriseProjectById, UUID_RE } = require('../utils/projectAccess');

// Attach audit hook to all terraform routes
router.use(attachAuditResponseHook);

// FIX: dedicated stricter rate limiter for compute-heavy unauthenticated endpoints.
// /fmt and /validate each spawn a Docker container or shell process; without a
// tight per-IP limit, any anonymous caller can exhaust CPU/Docker resources.
// 20 req/15 min mirrors the authLimiter ceiling used for login/register.
const terraformComputeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.connection?.remoteAddress || 'unknown',
  handler: (req, res) => {
    res.set('Retry-After', String(15 * 60));
    res.status(429).json({
      error: 'Too many formatting/validation requests — slow down',
      retryAfter: 15 * 60,
    });
  },
});

// ── Input guard ────────────────────────────────────────────────
function guardHcl(req, res) {
  const { hcl } = req.body;
  if (!hcl || typeof hcl !== 'string') {
    res.status(400).json({ error: 'HCL content required' }); return null;
  }
  if (hcl.length > 1_000_000) {
    res.status(413).json({ error: 'HCL payload too large (max 1 MB)' }); return null;
  }
  const clean = stripHtml(hcl);

  // SECURITY FIX (critical, was missing entirely): reject Terraform code-
  // execution primitives (provisioner "local-exec"/"remote-exec", data
  // "external") BEFORE any HCL reaches `terraform` — whether that's fmt,
  // validate, plan, cost, scan, init, or apply. This runs first, ahead of
  // secret detection, because these constructs are dangerous independent of
  // whether they also happen to contain a literal secret. See CHANGELOG for
  // the full writeup of why this was critical (RCE + credential exfil via
  // a single "read-only" plan request).
  const dangerous = detectDangerousConstructs(clean);
  if (dangerous.length > 0) {
    res.status(400).json({
      error: 'HCL contains a Terraform construct that executes code and is not permitted: ' +
        dangerous.map(d => d.name).join(', ') + '.',
      details: dangerous.map(d => d.hint),
    });
    return null;
  }

  // Secret detection — block if literal AWS keys found
  const secrets = detectSecrets(clean);
  if (secrets.length > 0) {
    res.status(400).json({
      error: 'Literal secret detected in HCL. Use aws_secretsmanager_secret_version or aws_ssm_parameter data sources instead.',
      secrets: secrets.map(s => s.name),
    });
    return null;
  }

  if (hasMarkup(hcl)) {
    console.warn(`[sanitize] Suspicious markup detected; correlationId=${req.headers['x-correlation-id'] || 'none'}`);
  }
  return clean;
}

/**
 * Read the optional `runner` field from the request body.
 * Accepts 'local' | 'docker' | 'auto'; anything else collapses to 'auto'.
 */
function readRunnerMode(req) {
  const mode = req.body?.runner;
  if (mode === 'local' || mode === 'docker') return mode;
  return 'auto';
}

function isValidProjectId(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Insert the execution_jobs row a job will be tracked under, generating the
 * id up front so the same id is shared by: the DB row, the BullMQ job, and
 * the WebSocket channel the frontend subscribes to for live logs/result.
 */
async function createExecutionJobRow({ projectId, userId, type, hcl }) {
  const id = crypto.randomUUID();
  const hclHash = crypto.createHash('sha256').update(hcl).digest('hex');
  await db.query(
    `INSERT INTO execution_jobs (id, project_id, user_id, type, status, hcl_hash)
     VALUES ($1, $2, $3, $4, 'queued', $5)`,
    [id, projectId || null, userId || null, type, hclHash]
  );
  return id;
}

const { DEFAULT_AWS_REGION } = require('../config/region');

// ... (see readRunnerMode above)

function localSuggestions(hcl) {
  const t = String(hcl || '');
  const line = t.split('\n').slice(-1)[0] || '';
  const trimmed = line.trim();

  const base = [];

  if (/^provider\s+"?aws"?\b/.test(trimmed) || /\brequired_providers\b/.test(trimmed)) {
    base.push({
      label: `region = "${DEFAULT_AWS_REGION}"`,
      insertText: `  region = "${DEFAULT_AWS_REGION}"`,
      kind: 'property',
    });
  }

  if (/^resource\s+"/.test(trimmed) || /\bresource\s+\"aws_/.test(trimmed)) {
    base.push({
      label: 'Example: resource "aws_s3_bucket" "example" {}',
      insertText: 'resource "aws_s3_bucket" "example" {\n  bucket = "example-bucket"\n}',
      kind: 'snippet',
    });
    base.push({
      label: 'Example: tags = { ... }',
      insertText: '  tags = {\n    project = var.project_name\n  }',
      kind: 'snippet',
    });
  }

  if (/\bvariable\s+"/.test(trimmed)) {
    base.push({ label: 'type = string', insertText: '  type = string', kind: 'property' });
    base.push({ label: 'default = ""', insertText: '  default = ""', kind: 'property' });
  }

  if (/\boutput\s+"/.test(trimmed)) {
    base.push({ label: 'value = <expr>', insertText: '  value = <expression>', kind: 'property' });
  }

  base.push({
    label: 'Format document (Ctrl+Shift+F)',
    insertText: null,
    kind: 'action',
    action: 'fmt',
  });

  return base.filter(x => x.insertText !== undefined).slice(0, 12);
}

// ── POST /api/terraform/fmt ─────────────────────────────────────
// FIX: was optionalAuth (anonymous callers could exhaust Docker resources).
// Now requires authentication AND a dedicated tight rate limiter.
router.post('/fmt', authMiddleware, terraformComputeLimiter, audit('terraform.fmt'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);
  try {
    const result = await runFmt(hcl, null, mode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/validate ───────────────────────────────
// FIX: was optionalAuth — same reasoning as /fmt above.
// FIX (Phase 1 — async execution wiring): this used to call runValidate +
// runCheckov directly, blocking the HTTP request for the full duration of
// the Terraform CLI subprocess — a real timeout risk on large HCL files.
// It now goes through jobQueue.enqueue(), which transparently runs inline
// when Redis is unreachable (small/typical requests still feel synchronous
// — same response shape as before, just with a `jobId` added) or hands off
// to the BullMQ worker when Redis is up, returning 202 immediately so large
// files can run in the background while the frontend streams progress over
// /ws/jobs?id=<jobId>.
router.post('/validate', authMiddleware, terraformComputeLimiter, audit('terraform.validate'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);
  const projectId = isValidProjectId(req.body.project_id) ? req.body.project_id : null;

  try {
    const jobId = await createExecutionJobRow({ projectId, userId: req.user.id, type: 'validate', hcl });
    const { result } = await enqueue(
      { jobId, type: 'validate', hcl, mode, projectId, userId: req.user.id },
      dispatchAndPersist
    );

    if (result) {
      // Ran inline (no reachable Redis) — full result is already known.
      return res.json({ jobId, ...result });
    }
    // Genuinely async — frontend must subscribe to /ws/jobs?id=<jobId> or
    // poll GET /api/terraform/jobs/:jobId for the result.
    return res.status(202).json({ jobId, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/suggest ────────────────────────────────
router.post('/suggest', optionalAuth, audit('terraform.suggest'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;

  try {
    const cursor = req.body?.cursor;
    const suggestions = localSuggestions(hcl);

    res.json({
      suggestions,
      meta: {
        receivedCursor: !!cursor,
        count: suggestions.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/plan ────────────────────────────────────
// FIX (Phase 1 — async execution wiring): previously blocked the HTTP
// request for the full duration of `terraform plan` (can be 30–120 s for
// large plans with many providers). Now enqueued through the shared job
// system; the response is either the full inline result (no Redis) or a
// 202 + jobId for the frontend to stream via /ws/jobs?id=<jobId>.
router.post('/plan', authMiddleware, audit('terraform.plan'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);
  const projectId = isValidProjectId(req.body.project_id) ? req.body.project_id : null;

  // SECURITY FIX (critical): use_real_credentials used to be gated by nothing
  // more than authMiddleware (any authenticated user, any role). Attaching
  // real credentials also flips the Docker sandbox network from `none` to
  // `bridge` (see runner.js), which is a materially higher-privilege action
  // than a normal offline/mock plan. Now that guardHcl() always blocks
  // local-exec/remote-exec/data-external (see above), the direct RCE path is
  // closed — but "plan with real credentials + network access" still now
  // requires the same project role gate as /apply, instead of only auth.
  //
  // SECURITY FIX (critical — C-06): this handler used to call
  // getDecryptedAwsCredentials() right here and put the resulting plaintext
  // accessKeyId/secretAccessKey/sessionToken directly into the object handed
  // to enqueue(). enqueue() -> jobQueue.js's queue.add() serializes that
  // entire object into a BullMQ job in Redis, and with the default
  // removeOnComplete:100 / removeOnFail:200, Redis ends up holding a rolling
  // window of up to 300 sets of plaintext AWS credentials — made far worse
  // by Redis previously having no auth at all (see docker-compose.yml fix).
  // Fix: never let credential material enter the job payload at all — only
  // a boolean flag is enqueued, and the job processor (services/
  // terraformJobs.js) fetches + decrypts credentials itself, inside the
  // worker, at the moment it's about to call runPlan() — so secrets are
  // decrypted once, held only in local process memory for the duration of
  // that call, and never serialized anywhere.
  let useRealCredentials = false;
  if (req.body.use_real_credentials) {
    if (!projectId) {
      return res.status(400).json({
        error: 'project_id is required to plan with real AWS credentials.',
      });
    }
    const project = await authoriseProjectById(req, res, projectId, ['deployer', 'admin', 'user']);
    if (!project) return; // authoriseProjectById already sent 403/404
    useRealCredentials = true;
  }

  try {
    const jobId = await createExecutionJobRow({ projectId, userId: req.user.id, type: 'plan', hcl });
    const { result } = await enqueue(
      { jobId, type: 'plan', hcl, mode, projectId, userId: req.user.id, useRealCredentials },
      dispatchAndPersist
    );

    if (result) {
      if (result.blocked) {
        return res.status(422).json({ jobId, ...result });
      }
      return res.json({ jobId, ...result });
    }
    return res.status(202).json({ jobId, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/cost ─────────────────────────────────────
router.post('/cost', optionalAuth, async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  try {
    const result = await runInfracost(hcl);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/scan ─────────────────────────────────────
router.post('/scan', optionalAuth, async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  try {
    const [checkov, networkWarnings] = await Promise.all([
      runCheckov(hcl),
      Promise.resolve(lintNetworkRules(hcl)),
    ]);
    res.json({ checkov, networkWarnings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── POST /api/terraform/init ──────────────────────────────────────────────────
router.post('/init', optionalAuth, audit('terraform.init'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);
  try {
    const result = await runInit(hcl, null, mode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/terraform/apply ─────────────────────────────────────────────────
// This is the new route wired to the Apply button in the Builder UI.
//
// Design decisions:
//  • Auth required — apply provisions real cloud infrastructure and must be
//    tied to an authenticated user (audit trail, project_members role check).
//  • Requires saved AWS credentials — we explicitly reject requests where the
//    user has no real credentials saved, rather than silently running apply
//    with mock/no credentials (which would either fail confusingly or, worse,
//    no-op while the UI shows "Apply succeeded").
//  • Requires a project_id — apply is a high-stakes action; it must be
//    associated with a project so we can record it in execution_jobs and
//    audit_logs against the right resource. Ad-hoc applies without a project
//    are rejected.
//  • Role gate — only 'deployer', 'admin', and the project owner may apply.
//    'editor' can plan but not apply. 'viewer' can only read.
//  • Always async — unlike plan/validate where the inline fallback is fine
//    for small files, apply can take 5–15 minutes for a real stack. We
//    always return 202 + jobId and stream progress over /ws/jobs?id=<jobId>.
//    The frontend ApplyStatusPanel subscribes to that WebSocket and renders
//    the live log + final outcome.
router.post('/apply', authMiddleware, audit('terraform.apply'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;

  const projectId = isValidProjectId(req.body.project_id) ? req.body.project_id : null;
  if (!projectId) {
    return res.status(400).json({ error: 'project_id is required to run apply' });
  }

  // Role check — only deployer / owner may apply
  const project = await authoriseProjectById(req, res, projectId, ['deployer', 'admin', 'user']);
  if (!project) return; // authoriseProjectById already sent 403/404

  // Credential check — must have saved real AWS credentials.
  // SECURITY FIX (critical — C-06): this used to call
  // getDecryptedAwsCredentials() here and stash the plaintext result in
  // `awsCredentials`, which was then put straight into the job payload
  // passed to enqueue() — and from there into the BullMQ job in Redis (see
  // the matching comment on POST /plan above for the full writeup). This
  // route only needs to know WHETHER credentials exist, not what they are,
  // so it now uses the cheap existence check hasAwsCredentials() (no
  // decryption at all) and defers the actual decrypt to the job processor,
  // at execution time, inside the worker.
  let credentialsExist;
  try {
    const { hasAwsCredentials } = require('../utils/awsCrypto');
    credentialsExist = await hasAwsCredentials(req.user.id);
  } catch (credErr) {
    return res.status(500).json({ error: 'Failed to check AWS credentials: ' + credErr.message });
  }
  if (!credentialsExist) {
    return res.status(422).json({
      error: 'No AWS credentials saved. Go to Settings → AWS Credentials and connect your account before running apply.',
      code: 'NO_CREDENTIALS',
    });
  }

  const mode = readRunnerMode(req);

  try {
    const jobId = await createExecutionJobRow({ projectId, userId: req.user.id, type: 'apply', hcl });

    // Always enqueue — never run apply inline on the HTTP request
    // (apply is too slow; even the in-process fallback fires the processor
    //  asynchronously and returns immediately here). Note: no credential
    // material in this payload — see SECURITY FIX comment above.
    await enqueue(
      { jobId, type: 'apply', hcl, mode, projectId, userId: req.user.id, useRealCredentials: true },
      dispatchAndPersist
    );

    res.status(202).json({
      jobId,
      status: 'queued',
      message: 'Apply job queued. Subscribe to /ws/jobs?id=' + jobId + ' for live logs.',
      wsUrl: `/ws/jobs?id=${jobId}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/terraform/jobs/:jobId ───────────────────────────────────────────
// Status/result polling endpoint for the frontend ApplyStatusPanel and for
// any client that can't maintain a WebSocket connection. Returns the full
// execution_jobs row including plan_summary, checkov_summary, and error.
router.get('/jobs/:jobId', authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  try {
    const row = await db.query(
      `SELECT ej.id, ej.type, ej.status, ej.plan_summary, ej.checkov_summary,
              ej.error, ej.queued_at, ej.started_at, ej.finished_at,
              ej.project_id, ej.user_id, ej.cost_delta
         FROM execution_jobs ej
        WHERE ej.id = $1
          AND (ej.user_id = $2 OR EXISTS (
                SELECT 1 FROM projects p
                LEFT JOIN project_members pm
                  ON pm.project_id = p.id AND pm.user_id = $2 AND pm.accepted_at IS NOT NULL
               WHERE p.id = ej.project_id
                 AND (p.user_id = $2 OR pm.user_id IS NOT NULL)
              ))`,
      [jobId, req.user.id]
    );
    if (!row.rows.length) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }
    res.json(row.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/terraform/jobs ───────────────────────────────────────────────────
// List recent jobs for the authenticated user (own jobs + jobs on shared
// projects). Supports optional ?project_id=<uuid> and ?type=apply|plan|validate
// filters. Returns at most 50 rows ordered most-recent-first.
router.get('/jobs', authMiddleware, async (req, res) => {
  const { project_id, type, limit = 50 } = req.query;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const conditions = [
    `(ej.user_id = $1 OR EXISTS (
        SELECT 1 FROM projects p
        LEFT JOIN project_members pm
          ON pm.project_id = p.id AND pm.user_id = $1 AND pm.accepted_at IS NOT NULL
       WHERE p.id = ej.project_id
         AND (p.user_id = $1 OR pm.user_id IS NOT NULL)
      ))`
  ];
  const params = [req.user.id];

  if (project_id && UUID_RE.test(project_id)) {
    conditions.push(`ej.project_id = $${params.push(project_id)}`);
  }
  if (type && ['fmt', 'validate', 'plan', 'apply'].includes(type)) {
    conditions.push(`ej.type = $${params.push(type)}`);
  }

  try {
    const rows = await db.query(
      `SELECT ej.id, ej.type, ej.status, ej.plan_summary, ej.checkov_summary,
              ej.error, ej.queued_at, ej.started_at, ej.finished_at,
              ej.project_id, ej.cost_delta,
              p.name AS project_name
         FROM execution_jobs ej
         LEFT JOIN projects p ON p.id = ej.project_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ej.queued_at DESC
        LIMIT ${safeLimit}`,
      params
    );
    res.json({ jobs: rows.rows, total: rows.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
