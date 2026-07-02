'use strict';
/**
 * /api/admin — Phase 3: Full admin panel backend
 *
 * All routes require admin role.
 *
 * Routes:
 *   GET  /api/admin/metrics         platform metrics dashboard
 *   GET  /api/admin/users           list all users (paginated)
 *   GET  /api/admin/users/:id       get single user
 *   PUT  /api/admin/users/:id/role  change user role
 *   PUT  /api/admin/users/:id/suspend  suspend/unsuspend user
 *   DELETE /api/admin/users/:id     delete user (and all their data)
 *   GET  /api/admin/projects        all projects across all users
 *   POST /api/admin/sanitize-hcl   HCL sanitization pass
 *   GET  /api/admin/system          system / env status
 */
const router   = require('express').Router();
const db       = require('../db/connection');
const { stripHtml } = require('../utils/sanitize');
const { authMiddleware, requireRole, ROLE_LEVELS } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = Object.keys(ROLE_LEVELS);

router.use(authMiddleware, requireRole('admin'));

// ─── GET /api/admin/metrics ───────────────────────────────────────────────────
router.get('/metrics', async (req, res) => {
  try {
    const [users, projects, resources, execJobs, auditLogs, policyRules, changReqs, notifs] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE role='admin')             AS admins,
          COUNT(*) FILTER (WHERE role='deployer')          AS deployers,
          COUNT(*) FILTER (WHERE role='editor')            AS editors,
          COUNT(*) FILTER (WHERE role='user')              AS users,
          COUNT(*) FILTER (WHERE role='viewer')            AS viewers,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
        FROM users
      `),
      db.query(`
        SELECT
          COUNT(*)                                              AS total,
          COUNT(DISTINCT aws_region)                            AS regions,
          COUNT(DISTINCT environment)                           AS environments,
          COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days') AS active_this_week
        FROM projects
      `),
      db.query('SELECT COUNT(*) AS total, COUNT(DISTINCT service_type) AS unique_types FROM resources'),
      db.query(`
        SELECT
          COUNT(*)                                             AS total,
          COUNT(*) FILTER (WHERE status='succeeded')           AS succeeded,
          COUNT(*) FILTER (WHERE status='failed')              AS failed,
          COUNT(*) FILTER (WHERE status='running')             AS running,
          COUNT(*) FILTER (WHERE type='plan')                  AS plans,
          COUNT(*) FILTER (WHERE type='apply')                 AS applies,
          COUNT(*) FILTER (WHERE queued_at > NOW() - INTERVAL '24 hours') AS last_24h
        FROM execution_jobs
      `),
      db.query(`SELECT COUNT(*) AS total FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE enabled) AS enabled FROM policy_rules`).catch(() => ({ rows: [{ total: 0, enabled: 0 }] })),
      db.query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status='open') AS open,
               COUNT(*) FILTER (WHERE status='approved') AS approved
        FROM change_requests
      `).catch(() => ({ rows: [{ total: 0, open: 0, approved: 0 }] })),
      db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE read_at IS NULL) AS unread FROM notifications`).catch(() => ({ rows: [{ total: 0, unread: 0 }] })),
    ]);

    // Top services
    const topServices = await db.query(`
      SELECT service_type, COUNT(*) AS count
      FROM resources GROUP BY service_type
      ORDER BY count DESC LIMIT 10
    `);

    // Daily activity (last 14 days)
    const dailyActivity = await db.query(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM audit_logs
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({
      users:         users.rows[0],
      projects:      projects.rows[0],
      resources:     resources.rows[0],
      execution:     execJobs.rows[0],
      audit_24h:     parseInt(auditLogs.rows[0].total, 10),
      policies:      policyRules.rows[0],
      change_requests: changReqs.rows[0],
      notifications: notifs.rows[0],
      top_services:  topServices.rows,
      daily_activity: dailyActivity.rows,
      generated_at:  new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { search, role, limit = 50, offset = 0 } = req.query;

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`LOWER(email) LIKE $${params.length}`);
  }
  if (role && VALID_ROLES.includes(role)) {
    params.push(role);
    conditions.push(`u.role = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit, 10), 200));
  params.push(Math.max(parseInt(offset, 10), 0));

  try {
    const countRes = await db.query(
      `SELECT COUNT(*) FROM users u ${where}`,
      params.slice(0, params.length - 2)
    );

    const { rows } = await db.query(`
      SELECT
        u.id, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM projects WHERE user_id = u.id)     AS project_count,
        (SELECT COUNT(*) FROM execution_jobs WHERE user_id = u.id) AS job_count,
        (SELECT MAX(created_at) FROM audit_logs WHERE user_id = u.id) AS last_active
      FROM users u
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({
      total: parseInt(countRes.rows[0].count, 10),
      users: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user ID' });
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM projects WHERE user_id=u.id)     AS project_count,
        (SELECT COUNT(*) FROM execution_jobs WHERE user_id=u.id) AS job_count,
        (SELECT json_agg(p ORDER BY p.updated_at DESC)
         FROM (SELECT id, name, environment, aws_region, updated_at FROM projects WHERE user_id=u.id LIMIT 5) p
        ) AS recent_projects
      FROM users u WHERE u.id=$1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/admin/users/:id/role ───────────────────────────────────────────
router.put('/users/:id/role', audit('admin.user.role_change'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user ID' });
  const { role } = req.body;

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  // Prevent admin from demoting themselves
  if (req.params.id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot change your own admin role' });
  }

  try {
    const { rows } = await db.query(
      'UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, role',
      [role, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────
router.delete('/users/:id', audit('admin.user.delete'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid user ID' });

  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    const { rowCount } = await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/projects ──────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  const { limit = 50, offset = 0, search, user_id } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`LOWER(p.name) LIKE $${params.length}`);
  }
  if (user_id && UUID_RE.test(user_id)) {
    params.push(user_id);
    conditions.push(`p.user_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit, 10), 200));
  params.push(Math.max(parseInt(offset, 10), 0));

  try {
    const { rows } = await db.query(`
      SELECT p.*, u.email AS owner_email,
             (SELECT COUNT(*) FROM resources WHERE project_id=p.id) AS resource_count
      FROM projects p
      LEFT JOIN users u ON u.id=p.user_id
      ${where}
      ORDER BY p.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/system ────────────────────────────────────────────────────
router.get('/system', async (req, res) => {
  const checks = {};

  // Database
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'ok' };
  } catch (e) {
    checks.database = { status: 'error', error: e.message };
  }

  // Redis
  try {
    const { probeRedis } = require('../services/jobQueue');
    if (typeof probeRedis === 'function') {
      const ok = await probeRedis(2000);
      checks.redis = { status: ok ? 'ok' : 'unavailable' };
    } else {
      checks.redis = { status: 'unknown' };
    }
  } catch {
    checks.redis = { status: 'unknown' };
  }

  // OPA
  const { findOpaBinary } = require('../services/opaEval');
  const opaBin = typeof findOpaBinary === 'function' ? await findOpaBinary().catch(() => null) : null;
  checks.opa = { status: opaBin ? 'available' : 'not-installed', path: opaBin || null };

  res.json({
    checks,
    env: {
      node_env:     process.env.NODE_ENV || 'development',
      database_url: process.env.DATABASE_URL ? '✓ configured' : '✗ missing',
      redis_url:    process.env.REDIS_URL    ? '✓ configured' : '✗ missing',
      encrypt_key:  process.env.ENCRYPT_KEY  ? '✓ configured' : '✗ missing',
      smtp:         process.env.SMTP_USER    ? '✓ configured' : '✗ missing',
    },
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// ─── POST /api/admin/sanitize-hcl ────────────────────────────────────────────
router.post('/sanitize-hcl', async (req, res) => {
  try {
    const results = { resources: 0, project_versions: 0 };
    const r = await db.query(
      "SELECT id, hcl_output FROM resources WHERE hcl_output IS NOT NULL AND (hcl_output LIKE '%<%' OR hcl_output LIKE '%color:%')"
    );
    for (const row of r.rows) {
      const cleaned = stripHtml(row.hcl_output);
      if (cleaned !== row.hcl_output) {
        await db.query('UPDATE resources SET hcl_output=$1 WHERE id=$2', [cleaned, row.id]);
        results.resources++;
      }
    }

    const v = await db.query(
      "SELECT id, full_hcl FROM project_versions WHERE full_hcl IS NOT NULL AND (full_hcl LIKE '%<%' OR full_hcl LIKE '%color:%')"
    );
    for (const row of v.rows) {
      const cleaned = stripHtml(row.full_hcl);
      if (cleaned !== row.full_hcl) {
        await db.query('UPDATE project_versions SET full_hcl=$1 WHERE id=$2', [cleaned, row.id]);
        results.project_versions++;
      }
    }

    res.json({ success: true, sanitized: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
