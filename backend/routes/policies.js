'use strict';
/**
 * /api/policies  — Governance-as-Code policy CRUD
 *
 * Admin-only CRUD for `policy_rules` table.
 * Each rule stores a Rego policy (or JS-evaluatable subset) that is run
 * against every `terraform plan` result before execution is allowed.
 *
 * Routes:
 *   GET    /api/policies                  list all rules (admin)
 *   POST   /api/policies                  create rule (admin)
 *   PUT    /api/policies/:id              update rule (admin)
 *   DELETE /api/policies/:id              delete rule (admin)
 *   POST   /api/policies/:id/toggle       enable/disable (admin)
 *   POST   /api/policies/seed-templates   seed built-in templates (admin)
 *   POST   /api/policies/evaluate         ad-hoc test eval (admin/deployer)
 */
const router = require('express').Router();
const db = require('../db/connection');
const { handleDbError } = require('../utils/errorHandler');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const { BUILT_IN_TEMPLATES, evaluateAllPolicies, evalJsSubset } = require('../services/opaEval');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// ─── Ensure policy_rules table exists ────────────────────────────────────────
// (Also ensured by Phase 2-5 migration; this is a belt-and-braces fallback)
async function ensurePolicyTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS policy_rules (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      rego_source TEXT NOT NULL,
      severity    VARCHAR(20) DEFAULT 'HIGH',
      enabled     BOOLEAN DEFAULT true,
      blocks_plan BOOLEAN DEFAULT false,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
}
ensurePolicyTable();

// ─── All policy routes require authentication ─────────────────────────────────
router.use(authMiddleware);
// SECURITY FIX (H-01): audit() calls below were a silent no-op without this —
// the entire /api/policies CRUD surface (create/update/delete/toggle a
// governance rule) had no audit trail at all.
router.use(attachAuditResponseHook);

// ─── GET /api/policies ────────────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT pr.*, u.email AS created_by_email
      FROM policy_rules pr
      LEFT JOIN users u ON u.id = pr.created_by
      ORDER BY pr.severity DESC,
               pr.blocks_plan DESC,
               pr.name
    `);
    res.json(rows);
  } catch (e) {
    handleDbError(e, res, 'Failed to fetch policies');
  }
});

// ─── GET /api/policies/:id ────────────────────────────────────────────────────
router.get('/:id', requireRole('user'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid policy ID' });
  try {
    const { rows } = await db.query(
      'SELECT * FROM policy_rules WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Policy not found' });
    res.json(rows[0]);
  } catch (e) {
    handleDbError(e, res, 'Failed to fetch policy');
  }
});

// ─── POST /api/policies ───────────────────────────────────────────────────────
router.post('/', requireRole('admin'), audit('policy.create'), async (req, res) => {
  const { name, description, rego_source, severity = 'HIGH', enabled = true, blocks_plan = false } = req.body;

  if (!name || !rego_source) {
    return res.status(400).json({ error: 'name and rego_source are required' });
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO policy_rules (name, description, rego_source, severity, enabled, blocks_plan, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [name.trim(), description || '', rego_source, severity, enabled, blocks_plan, req.user.id]);

    res.status(201).json(rows[0]);
  } catch (e) {
    handleDbError(e, res, 'Failed to create policy');
  }
});

// ─── PUT /api/policies/:id ────────────────────────────────────────────────────
router.put('/:id', requireRole('admin'), audit('policy.update'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid policy ID' });

  const { name, description, rego_source, severity, enabled, blocks_plan } = req.body;

  // Build dynamic update
  const fields = [];
  const vals   = [];
  const set = (col, val) => { vals.push(val); fields.push(`${col} = $${vals.length}`); };

  if (name        !== undefined) set('name',        name.trim());
  if (description !== undefined) set('description', description);
  if (rego_source !== undefined) set('rego_source', rego_source);
  if (severity    !== undefined) {
    if (!VALID_SEVERITIES.includes(severity))
      return res.status(400).json({ error: `Invalid severity: ${severity}` });
    set('severity', severity);
  }
  if (enabled     !== undefined) set('enabled',     !!enabled);
  if (blocks_plan !== undefined) set('blocks_plan', !!blocks_plan);

  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  set('updated_at', new Date());

  vals.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE policy_rules SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Policy not found' });
    res.json(rows[0]);
  } catch (e) {
    handleDbError(e, res, 'Failed to update policy');
  }
});

// ─── DELETE /api/policies/:id ─────────────────────────────────────────────────
router.delete('/:id', requireRole('admin'), audit('policy.delete'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid policy ID' });
  try {
    const { rowCount } = await db.query('DELETE FROM policy_rules WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Policy not found' });
    res.json({ deleted: true });
  } catch (e) {
    handleDbError(e, res, 'Failed to delete policy');
  }
});

// ─── POST /api/policies/:id/toggle ───────────────────────────────────────────
router.post('/:id/toggle', requireRole('admin'), audit('policy.toggle'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid policy ID' });
  try {
    const { rows } = await db.query(`
      UPDATE policy_rules SET enabled = NOT enabled, updated_at = NOW()
      WHERE id = $1 RETURNING id, name, enabled
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Policy not found' });
    res.json(rows[0]);
  } catch (e) {
    handleDbError(e, res, 'Failed to toggle policy');
  }
});

// ─── POST /api/policies/seed-templates ───────────────────────────────────────
router.post('/seed-templates', requireRole('admin'), audit('policy.seed'), async (req, res) => {
  try {
    let created = 0;
    let skipped = 0;

    for (const tmpl of BUILT_IN_TEMPLATES) {
      const existing = await db.query(
        'SELECT id FROM policy_rules WHERE name = $1',
        [tmpl.name]
      );
      if (existing.rows.length) { skipped++; continue; }

      await db.query(`
        INSERT INTO policy_rules (name, description, rego_source, severity, enabled, blocks_plan, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [tmpl.name, tmpl.description, tmpl.rego_source, tmpl.severity, true, tmpl.blocks_plan, req.user.id]);
      created++;
    }

    res.json({ seeded: true, created, skipped, total: BUILT_IN_TEMPLATES.length });
  } catch (e) {
    handleDbError(e, res, 'Failed to seed policy templates');
  }
});

// ─── POST /api/policies/evaluate  (ad-hoc test) ──────────────────────────────
router.post('/evaluate', requireRole('deployer'), async (req, res) => {
  const { rego_source, plan_result, resources } = req.body;

  if (!rego_source) {
    return res.status(400).json({ error: 'rego_source is required for evaluation' });
  }

  try {
    // For ad-hoc tests, use the JS evaluator (fast, no file I/O)
    const inputDoc = {
      plan: {
        resource_changes: plan_result?.resource_changes || [],
        summary: plan_result?.summary || {},
      },
      resources: (resources || []).map(r => ({
        type: r.service_type || r.type,
        name: r.resource_name || r.name,
        config: r.config || {},
      })),
    };

    const result = evalJsSubset(rego_source, inputDoc);
    res.json({
      passed:     result.violations.length === 0,
      violations: result.violations,
      engine:     'js-subset',
    });
  } catch (e) {
    handleDbError(e, res, 'Failed to evaluate policy');
  }
});

// ─── GET /api/policies/summary ────────────────────────────────────────────────
router.get('/summary', requireRole('user'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                    AS total,
        COUNT(*) FILTER (WHERE enabled)             AS enabled,
        COUNT(*) FILTER (WHERE blocks_plan)         AS blocking,
        COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical,
        COUNT(*) FILTER (WHERE severity = 'HIGH')   AS high,
        COUNT(*) FILTER (WHERE severity = 'MEDIUM') AS medium,
        COUNT(*) FILTER (WHERE severity = 'LOW')    AS low
      FROM policy_rules
    `);
    res.json(rows[0]);
  } catch (e) {
    handleDbError(e, res, 'Failed to fetch policy summary');
  }
});

module.exports = router;
