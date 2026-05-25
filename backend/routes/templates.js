const router = require('express').Router();
const db = require('../db/connection');

router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM templates ORDER BY category, label');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:service', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM templates WHERE service_type = $1', [req.params.service]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
