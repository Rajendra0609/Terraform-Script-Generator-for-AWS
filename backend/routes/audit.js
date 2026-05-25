'use strict';
/**
 * Audit log viewer — admin-only.
 * GET /api/audit?action=project.delete&user=<uuid>&from=2026-01-01&limit=50
 */
const router = require('express').Router();
const db = require('../db/connection');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('admin'));

router.get('/', async (req, res) => {
  const { action, user, from, to, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (action) { params.push(`%${action}%`); conditions.push(`action ILIKE $${params.length}`); }
  if (user)   { params.push(user);           conditions.push(`user_id = $${params.length}`); }
  if (from)   { params.push(from);           conditions.push(`created_at >= $${params.length}`); }
  if (to)     { params.push(to);             conditions.push(`created_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit, 10), 200));
  params.push(parseInt(offset, 10));

  try {
    const result = await db.query(
      `SELECT al.*, u.email as user_email
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
