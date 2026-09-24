'use strict';
/**
 * /api/search — Global search across projects, resources, templates, policies
 *
 * GET /api/search?q=<query>&types=projects,resources,templates,policies&limit=20
 *
 * Returns a unified result array with { type, id, title, subtitle, link, updated_at }
 * scoped to what the authenticated user can access.
 */
const router = require('express').Router();
const db     = require('../db/connection');
const { handleDbError } = require('../utils/errorHandler');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

const ALLOWED_TYPES = new Set(['projects', 'resources', 'templates', 'policies', 'audit']);

router.get('/', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const types = req.query.types
    ? req.query.types.split(',').map(t => t.trim()).filter(t => ALLOWED_TYPES.has(t))
    : ['projects', 'resources', 'templates'];

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const pattern = `%${q.toLowerCase()}%`;
  const results = [];

  try {
    // ── Projects ─────────────────────────────────────────────────────────────
    if (types.includes('projects')) {
      const { rows } = await db.query(`
        SELECT p.id, p.name, p.description, p.aws_region, p.environment, p.updated_at,
               (SELECT COUNT(*) FROM resources r WHERE r.project_id = p.id) AS resource_count
        FROM projects p
        WHERE (p.user_id = $1
            OR p.id IN (
              SELECT project_id FROM project_members
              WHERE user_id = $1 AND accepted_at IS NOT NULL
            ))
          AND (LOWER(p.name) LIKE $2 OR LOWER(p.description) LIKE $2 OR LOWER(p.aws_region) LIKE $2)
        ORDER BY p.updated_at DESC
        LIMIT $3
      `, [req.user.id, pattern, Math.ceil(limit / types.length)]);

      for (const r of rows) {
        results.push({
          type:       'project',
          id:         r.id,
          title:      r.name,
          subtitle:   `${r.aws_region} · ${r.environment} · ${r.resource_count} resources`,
          link:       `/builder/${r.id}`,
          updated_at: r.updated_at,
          meta:       { aws_region: r.aws_region, environment: r.environment },
        });
      }
    }

    // ── Resources ─────────────────────────────────────────────────────────────
    if (types.includes('resources')) {
      const { rows } = await db.query(`
        SELECT res.id, res.resource_name, res.service_type, res.project_id,
               p.name AS project_name, res.created_at
        FROM resources res
        JOIN projects p ON p.id = res.project_id
        WHERE (p.user_id = $1
            OR p.id IN (
              SELECT project_id FROM project_members
              WHERE user_id = $1 AND accepted_at IS NOT NULL
            ))
          AND (LOWER(res.resource_name) LIKE $2 OR LOWER(res.service_type) LIKE $2)
        ORDER BY res.created_at DESC
        LIMIT $3
      `, [req.user.id, pattern, Math.ceil(limit / types.length)]);

      for (const r of rows) {
        results.push({
          type:       'resource',
          id:         r.id,
          title:      r.resource_name,
          subtitle:   `${r.service_type} in ${r.project_name}`,
          link:       `/builder/${r.project_id}`,
          updated_at: r.created_at,
          meta:       { service_type: r.service_type, project_id: r.project_id },
        });
      }
    }

    // ── Templates ─────────────────────────────────────────────────────────────
    if (types.includes('templates')) {
      const { rows } = await db.query(`
        SELECT id, label, service_type, category, updated_at
        FROM templates
        WHERE LOWER(label) LIKE $1 OR LOWER(service_type) LIKE $1 OR LOWER(category) LIKE $1
        ORDER BY updated_at DESC
        LIMIT $2
      `, [pattern, Math.ceil(limit / types.length)]);

      for (const r of rows) {
        results.push({
          type:       'template',
          id:         r.id,
          title:      r.label || r.service_type,
          subtitle:   `${r.category || 'Template'} · ${r.service_type}`,
          link:       `/builder?template=${r.service_type}`,
          updated_at: r.updated_at,
          meta:       { service_type: r.service_type, category: r.category },
        });
      }
    }

    // ── Policies (admin only) ─────────────────────────────────────────────────
    if (types.includes('policies') && req.user.role === 'admin') {
      const { rows } = await db.query(`
        SELECT id, name, description, severity, enabled, updated_at
        FROM policy_rules
        WHERE LOWER(name) LIKE $1 OR LOWER(description) LIKE $1
        ORDER BY updated_at DESC
        LIMIT $2
      `, [pattern, 10]).catch(() => ({ rows: [] }));

      for (const r of rows) {
        results.push({
          type:       'policy',
          id:         r.id,
          title:      r.name,
          subtitle:   `${r.severity} · ${r.enabled ? 'Enabled' : 'Disabled'}`,
          link:       `/admin?tab=policies`,
          updated_at: r.updated_at,
          meta:       { severity: r.severity, enabled: r.enabled },
        });
      }
    }

    // ── Audit logs (admin only) ───────────────────────────────────────────────
    if (types.includes('audit') && req.user.role === 'admin') {
      const { rows } = await db.query(`
        SELECT al.id, al.action, al.path, al.created_at, u.email AS actor_email
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE LOWER(al.action) LIKE $1 OR LOWER(u.email) LIKE $1
        ORDER BY al.created_at DESC
        LIMIT $2
      `, [pattern, 10]);

      for (const r of rows) {
        results.push({
          type:       'audit',
          id:         r.id,
          title:      r.action,
          subtitle:   `${r.actor_email || 'system'} · ${new Date(r.created_at).toLocaleString()}`,
          link:       `/admin?tab=audit`,
          updated_at: r.created_at,
          meta:       { actor: r.actor_email, path: r.path },
        });
      }
    }

    // Sort all results by recency
    results.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({
      query:   q,
      total:   results.length,
      results: results.slice(0, limit),
    });
  } catch (e) {
    handleDbError(e, res, 'Search failed');
  }
});

module.exports = router;
