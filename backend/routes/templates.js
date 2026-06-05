const router = require('express').Router();
const db = require('../db/connection');
// BUG-020 fix: template routes previously had no authentication guard, exposing
// the full template library (including schema_def and template_body) to
// unauthenticated callers and aiding reconnaissance.  Both routes now require a
// valid JWT.  The audit middleware logs every template access.
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

router.get('/', authMiddleware, audit('templates.list'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM templates ORDER BY category, label');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:service', authMiddleware, audit('templates.get'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM templates WHERE service_type = $1', [req.params.service]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
