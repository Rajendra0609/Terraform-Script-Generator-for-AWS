const router = require('express').Router();
const db = require('../db/connection');
const { stripHtml } = require('../utils/sanitize');
const { authMiddleware, requireRole } = require('../middleware/auth');

// All admin routes require authentication and admin role
router.use(authMiddleware, requireRole('admin'));

// Trigger a sanitization pass over persisted HCL fields.
router.post('/sanitize-hcl', async (req, res) => {
  try {
    const results = { resources: 0, project_versions: 0 };
    const r = await db.query("SELECT id, hcl_output FROM resources WHERE hcl_output IS NOT NULL AND (hcl_output LIKE '%<%' OR hcl_output LIKE '%color:%')");
    for (const row of r.rows) {
      const cleaned = stripHtml(row.hcl_output);
      if (cleaned !== row.hcl_output) {
        await db.query('UPDATE resources SET hcl_output = $1 WHERE id = $2', [cleaned, row.id]);
        results.resources++;
      }
    }

    const v = await db.query("SELECT id, full_hcl FROM project_versions WHERE full_hcl IS NOT NULL AND (full_hcl LIKE '%<%' OR full_hcl LIKE '%color:%')");
    for (const row of v.rows) {
      const cleaned = stripHtml(row.full_hcl);
      if (cleaned !== row.full_hcl) {
        await db.query('UPDATE project_versions SET full_hcl = $1 WHERE id = $2', [cleaned, row.id]);
        results.project_versions++;
      }
    }

    res.json({ success: true, sanitized: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
