const router = require('express').Router();
const db = require('../db/connection');
const { v4: uuidv4 } = require('uuid');

// List all projects
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, 
        (SELECT COUNT(*) FROM resources r WHERE r.project_id = p.id) as resource_count
       FROM projects p ORDER BY p.updated_at DESC`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single project with resources
router.get('/:id', async (req, res) => {
  try {
    const proj = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!proj.rows.length) return res.status(404).json({ error: 'Not found' });
    const resources = await db.query(
      'SELECT * FROM resources WHERE project_id = $1 ORDER BY position',
      [req.params.id]
    );
    res.json({ ...proj.rows[0], resources: resources.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create project
router.post('/', async (req, res) => {
  const { name, description, aws_region, environment, backend_config } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO projects (name, description, aws_region, environment, backend_config) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, description || '', aws_region || 'ap-south-1', environment || 'dev', backend_config || {}]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update project
router.put('/:id', async (req, res) => {
  const { name, description, aws_region, environment, backend_config } = req.body;
  try {
    const result = await db.query(
      `UPDATE projects SET name=$1, description=$2, aws_region=$3, environment=$4, backend_config=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [name, description, aws_region, environment, backend_config || {}, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save resources for a project
router.post('/:id/resources', async (req, res) => {
  const { resources } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM resources WHERE project_id = $1', [req.params.id]);
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      await client.query(
        `INSERT INTO resources (project_id, service_type, resource_name, config, is_module, module_source, hcl_output, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, r.service_type, r.resource_name, r.config || {},
         r.is_module || false, r.module_source || '', r.hcl_output || '', i]
      );
    }
    await client.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ saved: true, count: resources.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Get version history
router.get('/:id/versions', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM project_versions WHERE project_id=$1 ORDER BY version_number DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save version snapshot
router.post('/:id/versions', async (req, res) => {
  const { full_hcl, resource_count } = req.body;
  try {
    const vRes = await db.query(
      'SELECT COALESCE(MAX(version_number),0) as max_v FROM project_versions WHERE project_id=$1',
      [req.params.id]
    );
    const nextV = vRes.rows[0].max_v + 1;
    const result = await db.query(
      `INSERT INTO project_versions (project_id, version_number, full_hcl, resource_count)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, nextV, full_hcl, resource_count || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
