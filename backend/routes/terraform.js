const router = require('express').Router();
const { runFmt, runValidate } = require('../terraform/runner');

router.post('/fmt', async (req, res) => {
  const { hcl } = req.body;
  if (!hcl) return res.status(400).json({ error: 'HCL content required' });
  try {
    const result = await runFmt(hcl);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/validate', async (req, res) => {
  const { hcl } = req.body;
  if (!hcl) return res.status(400).json({ error: 'HCL content required' });
  try {
    const result = await runValidate(hcl);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
