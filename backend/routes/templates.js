const router = require('express').Router();
const db = require('../db/connection');
const { handleDbError } = require('../utils/errorHandler');
// BUG-020 fix: template routes previously had no authentication guard, exposing
// the full template library (including schema_def and template_body) to
// unauthenticated callers and aiding reconnaissance.  Both routes now require a
// valid JWT.
//
// SECURITY FIX (H-01): the comment that used to be here claimed "the audit
// middleware logs every template access" — that was false. audit() only
// labels a request; nothing writes a row unless attachAuditResponseHook is
// also mounted (it wasn't, on this router). It's mounted now for
// consistency with every other router, but note both routes below are GET
// requests, and middleware/audit.js's AUDITED_METHODS set deliberately
// excludes GET/HEAD/OPTIONS — read-only template browsing isn't mutating
// state, so it correctly still produces no audit_logs row even with the
// hook attached. If template access ever needs its own audit trail, that
// requires widening AUDITED_METHODS deliberately, not assuming audit()
// already covers it.
const { authMiddleware } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');

router.use(attachAuditResponseHook);

router.get('/', authMiddleware, audit('templates.list'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM templates ORDER BY category, label');
    res.json(result.rows);
  } catch (e) { handleDbError(e, res, 'Failed to fetch templates'); }
});

router.get('/:service', authMiddleware, audit('templates.get'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM templates WHERE service_type = $1', [req.params.service]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (e) { handleDbError(e, res, 'Failed to fetch template'); }
});

module.exports = router;
