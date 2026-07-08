'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { runFmt, runValidate, runPlan, runInit } = require('../terraform/runner');
const { runCheckov }   = require('../services/checkov');
const { runInfracost } = require('../services/infracost');
const { stripHtml, detectSecrets, lintNetworkRules, hasMarkup } = require('../utils/sanitize');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const db = require('../db/connection');

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

function localSuggestions(hcl) {
  const t = String(hcl || '');
  const line = t.split('\n').slice(-1)[0] || '';
  const trimmed = line.trim();

  const base = [];

  if (/^provider\s+"?aws"?\b/.test(trimmed) || /\brequired_providers\b/.test(trimmed)) {
    base.push({
      label: 'region = "ap-south-1"',
      insertText: '  region = "ap-south-1"',
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
router.post('/validate', authMiddleware, terraformComputeLimiter, audit('terraform.validate'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);

  // Network security linting (fast, synchronous — always runs)
  const networkWarnings = lintNetworkRules(hcl);

  try {
    const [validateResult, checkovResult] = await Promise.all([
      runValidate(hcl, null, mode),
      runCheckov(hcl),
    ]);

    // Persist validation log if project_id is a valid UUID.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const projectId = req.body.project_id;
    if (projectId && UUID_RE.test(projectId)) {
      db.query(
        'INSERT INTO validation_logs (project_id, is_valid, diagnostics) VALUES ($1,$2,$3)',
        [projectId, validateResult.valid ?? false, JSON.stringify(validateResult.diagnostics || [])]
      ).catch(() => {}); // fire-and-forget
    }

    res.json({
      ...validateResult,
      networkWarnings,
      checkov: checkovResult,
    });
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
router.post('/plan', authMiddleware, audit('terraform.plan'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  const mode = readRunnerMode(req);

  const networkWarnings = lintNetworkRules(hcl);

  try {
    const [planResult, checkovResult] = await Promise.all([
      runPlan(hcl, null, null, mode),
      runCheckov(hcl),
    ]);

    // Block plan if CRITICAL Checkov findings exist (configurable)
    const criticalFindings = (checkovResult.findings || []).filter(f => f.severity === 'CRITICAL');
    const blockOnCritical  = process.env.BLOCK_PLAN_ON_CRITICAL !== 'false';
    if (criticalFindings.length > 0 && blockOnCritical) {
      return res.status(422).json({
        error: `Plan blocked: ${criticalFindings.length} CRITICAL security finding(s) detected`,
        checkov: checkovResult,
        networkWarnings,
      });
    }

    res.json({ ...planResult, networkWarnings, checkov: checkovResult });
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

module.exports = router;
