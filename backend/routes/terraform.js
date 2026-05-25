'use strict';
const router = require('express').Router();
const { runFmt, runValidate, runPlan } = require('../terraform/runner');
const { runCheckov }   = require('../services/checkov');
const { runInfracost } = require('../services/infracost');
const { stripHtml, detectSecrets, lintNetworkRules } = require('../utils/sanitize');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const db = require('../db/connection');

// Attach audit hook to all terraform routes
router.use(attachAuditResponseHook);

// ─── Input guard ──────────────────────────────────────────────────────────────
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

  if (/[<>]|&lt;|color:|style=/.test(hcl)) {
    console.warn(`[sanitize] Suspicious content; correlationId=${req.headers['x-correlation-id'] || 'none'}`);
  }
  return clean;
}

// ─── POST /api/terraform/fmt ──────────────────────────────────────────────────
router.post('/fmt', optionalAuth, audit('terraform.fmt'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  try {
    const result = await runFmt(hcl);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/terraform/validate ────────────────────────────────────────────
router.post('/validate', optionalAuth, audit('terraform.validate'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;

  // Network security linting (fast, synchronous — always runs)
  const networkWarnings = lintNetworkRules(hcl);

  try {
    const [validateResult, checkovResult] = await Promise.all([
      runValidate(hcl),
      runCheckov(hcl),
    ]);

    // Persist validation log if project_id supplied
    const projectId = req.body.project_id;
    if (projectId) {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/terraform/plan ─────────────────────────────────────────────────
// Synchronous for small projects; use /api/jobs/plan for async streaming.
router.post('/plan', authMiddleware, audit('terraform.plan'), async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;

  const networkWarnings = lintNetworkRules(hcl);

  try {
    const [planResult, checkovResult] = await Promise.all([
      runPlan(hcl),
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/terraform/cost ─────────────────────────────────────────────────
router.post('/cost', optionalAuth, async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  try {
    const result = await runInfracost(hcl);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/terraform/scan ─────────────────────────────────────────────────
router.post('/scan', optionalAuth, async (req, res) => {
  const hcl = guardHcl(req, res);
  if (hcl === null) return;
  try {
    const [checkov, networkWarnings] = await Promise.all([
      runCheckov(hcl),
      Promise.resolve(lintNetworkRules(hcl)),
    ]);
    res.json({ checkov, networkWarnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
