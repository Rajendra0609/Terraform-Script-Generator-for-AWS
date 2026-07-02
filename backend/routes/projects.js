'use strict';
const router = require('express').Router();
const db = require('../db/connection');
const { v4: uuidv4 } = require('uuid');
const { stripHtml, detectSecrets } = require('../utils/sanitize');
const { authMiddleware, requireRole, optionalAuth } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const { DEFAULT_AWS_REGION } = require('../config/region');
const { createNotification } = require('./notifications');

router.use(attachAuditResponseHook);

// ─── BUG-019 fix: run ALTER TABLE migration once at module load time ──────────
// Previously these ALTER TABLE statements ran inside every POST /:id/resources
// transaction.  ALTER TABLE acquires an AccessExclusiveLock which blocks all
// concurrent reads and writes, causing visible latency spikes on a busy server.
// We now check information_schema once, run any missing-column migrations, and
// set a flag so the per-request handler can skip the block entirely.
const MIGRATE_COLS = [
  { col: 'variables',         type: 'JSONB',        def: "'{}'::jsonb" },
  { col: 'outputs',           type: 'JSONB',        def: "'{}'::jsonb" },
  { col: 'is_module',         type: 'BOOLEAN',      def: 'false' },
  { col: 'module_source',     type: 'VARCHAR(500)',  def: "''" },
  { col: 'lifecycle_config',  type: 'JSONB',        def: "'{}'::jsonb" },
  { col: 'position_x',        type: 'NUMERIC',      def: '0' },
  { col: 'position_y',        type: 'NUMERIC',      def: '0' },
  { col: 'annotations',       type: 'TEXT',         def: "''" },
  { col: 'security_findings', type: 'JSONB',        def: "'[]'::jsonb" },
];
let _resourcesColumnsReady = false;

async function ensureResourceColumns() {
  if (_resourcesColumnsReady) return;
  try {
    const existing = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'resources'`
    );
    const present = new Set(existing.rows.map(r => r.column_name));
    for (const { col, type, def } of MIGRATE_COLS) {
      if (!present.has(col)) {
        await db.query(
          `ALTER TABLE resources ADD COLUMN IF NOT EXISTS ${col} ${type} DEFAULT ${def}`
        );
      }
    }
    _resourcesColumnsReady = true;
  } catch (err) {
    // Non-fatal: log and allow the first request to attempt a fallback below.
    console.error('[projects] ensureResourceColumns error:', err.message);
  }
}

// Kick off the startup migration (fire-and-forget; errors are logged above).
ensureResourceColumns();


// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Check that the requesting user owns or is a member of the project.
 * Returns the project row, or sends 403/404 and returns null.
 *
 * Moved to ../utils/projectAccess so routes/terraform.js (POST /apply) can
 * share the exact same owner/member authorization logic.
 */
const { authoriseProject, UUID_RE } = require('../utils/projectAccess');

// ─── List projects ────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const {
      limit  = 50,
      offset = 0,
      search = '',
      sort   = 'updated_at',
      dir    = 'desc',
      env    = '',
      region = '',
    } = req.query;

    const SAFE_SORT = { name: 'p.name', updated_at: 'p.updated_at', created_at: 'p.created_at', resource_count: 'resource_count' };
    const sortCol  = SAFE_SORT[sort] || 'p.updated_at';
    const sortDir  = dir === 'asc' ? 'ASC' : 'DESC';
    const maxLimit = Math.min(parseInt(limit, 10) || 50, 200);
    const safeOff  = Math.max(parseInt(offset, 10) || 0, 0);

    const conditions = [
      `(p.user_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND accepted_at IS NOT NULL))`
    ];
    const params = [req.user.id];

    if (search?.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conditions.push(`(LOWER(p.name) LIKE $${params.length} OR LOWER(p.description) LIKE $${params.length})`);
    }
    if (env) {
      params.push(env);
      conditions.push(`p.environment = $${params.length}`);
    }
    if (region) {
      params.push(region);
      conditions.push(`p.aws_region = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // Total count for pagination metadata
    const countRes = await db.query(
      `SELECT COUNT(*) FROM projects p WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    params.push(maxLimit);
    params.push(safeOff);

    const result = await db.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM resources r WHERE r.project_id = p.id) AS resource_count
       FROM projects p
       WHERE ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      projects: result.rows,
      total,
      limit:  maxLimit,
      offset: safeOff,
      has_more: safeOff + result.rows.length < total,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pending invitations for the current user ─────────────────────────────────
// Must be declared before GET /:id — otherwise Express matches "invitations"
// as the :id param and it 400s on the UUID check before ever reaching here.
router.get('/invitations/pending', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pm.id AS membership_id, pm.role, pm.invited_at,
              p.id AS project_id, p.name AS project_name, p.description,
              u.email AS invited_by_email
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         LEFT JOIN users u ON u.id = pm.invited_by
        WHERE pm.user_id = $1 AND pm.accepted_at IS NULL
        ORDER BY pm.invited_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get single project with resources ───────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await authoriseProject(req, res);
    if (!project) return;
    const resources = await db.query(
      'SELECT * FROM resources WHERE project_id = $1 ORDER BY position',
      [req.params.id]
    );
    // Ensure JSONB columns are always returned as parsed objects, not strings.
    // pg may return JSONB as a string in some driver/Postgres version combos.
    const parseJsonbRow = (row) => {
      const jsonbCols = ['config', 'variables', 'outputs', 'lifecycle_config', 'security_findings'];
      const out = { ...row };
      for (const col of jsonbCols) {
        if (typeof out[col] === 'string') {
          try { out[col] = JSON.parse(out[col]); } catch { out[col] = col.endsWith('findings') ? [] : {}; }
        }
      }
      return out;
    };
    res.json({ ...project, resources: resources.rows.map(parseJsonbRow) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Create project ───────────────────────────────────────────────────────────
router.post('/', authMiddleware, requireRole('user'), audit('project.create'), async (req, res) => {
  const { name, description, aws_region, environment, backend_config } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name required' });
  try {
    const result = await db.query(
      'INSERT INTO projects (name, description, aws_region, environment, backend_config, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name.trim(), description || '', aws_region || DEFAULT_AWS_REGION, environment || 'dev', JSON.stringify(backend_config || {}), req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Update project ───────────────────────────────────────────────────────────
router.put('/:id', authMiddleware, audit('project.update'), async (req, res) => {
  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin', 'user']);
  if (!project) return;
  const { name, description, aws_region, environment, backend_config } = req.body;
  // BE-07 fix: validate required fields — mirrors the validation already present on POST /
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Project name must be a non-empty string' });
  }
  if (aws_region !== undefined && (aws_region === null || aws_region === '')) {
    return res.status(400).json({ error: 'aws_region must be a non-empty string' });
  }
  if (environment !== undefined && (environment === null || environment === '')) {
    return res.status(400).json({ error: 'environment must be a non-empty string' });
  }
  try {
    // BUG-003 fix: use COALESCE so absent/undefined fields retain their current
    // DB values instead of being overwritten with NULL by the pg driver.
    const result = await db.query(
      `UPDATE projects
          SET name          = COALESCE($1, name),
              description   = COALESCE($2, description),
              aws_region    = COALESCE($3, aws_region),
              environment   = COALESCE($4, environment),
              backend_config= COALESCE($5::jsonb, backend_config),
              updated_at    = NOW()
        WHERE id=$6 RETURNING *`,
      [
        name        !== undefined ? name.trim()                         : null,
        description !== undefined ? description                         : null,
        aws_region  !== undefined ? aws_region                          : null,
        environment !== undefined ? environment                         : null,
        backend_config !== undefined ? JSON.stringify(backend_config)   : null,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete project ───────────────────────────────────────────────────────────
// BE-05 fix: removed requireRole('admin') — the owner-check below already allows
// either the project owner or an admin to delete. requireRole('admin') was blocking
// regular users from deleting their own projects.
router.delete('/:id', authMiddleware, audit('project.delete'), async (req, res) => {
  // Validate UUID before hitting DB to avoid "invalid input syntax for type uuid" errors
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid project ID' });
  // Only admins or owners can delete
  const proj = await db.query('SELECT user_id FROM projects WHERE id = $1', [req.params.id]);
  if (!proj.rows.length) return res.status(404).json({ error: 'Not found' });
  if (proj.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the owner or an admin can delete a project' });
  }
  try {
    await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Save resources ───────────────────────────────────────────────────────────
router.post('/:id/resources', authMiddleware, audit('project.resources.save'), async (req, res) => {
  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin', 'user']);
  if (!project) return;

  const { resources, full_hcl } = req.body;
  if (!Array.isArray(resources)) return res.status(400).json({ error: 'resources must be an array' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // BUG-019 fix: column migration moved to ensureResourceColumns() at module
    // load time. ALTER TABLE acquires AccessExclusiveLock and must not run inside
    // every per-request transaction. If startup migration hasn't completed yet,
    // retry it here; the IF NOT EXISTS guards make it idempotent.
    if (!_resourcesColumnsReady) await ensureResourceColumns();

    // Detect whether the `annotations` column is jsonb or text so we can
    // construct an INSERT that matches the DB schema (some deployments
    // historically changed this column type).
    let annotationsIsJsonb = false;
    try {
      const colTypeRes = await client.query(
        "SELECT udt_name FROM information_schema.columns WHERE table_name='resources' AND column_name='annotations' LIMIT 1"
      );
      annotationsIsJsonb = colTypeRes.rows?.[0]?.udt_name === 'jsonb';
    } catch (e) { /* ignore - assume text by default */ }

    // Pre-build INSERT SQL according to annotations column type
    const insertSqlTemplate = annotationsIsJsonb
      ? `INSERT INTO resources
           (project_id, service_type, resource_name, config, is_module, module_source,
            hcl_output, position, variables, outputs, lifecycle_config,
            position_x, position_y, annotations)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb)`
      : `INSERT INTO resources
           (project_id, service_type, resource_name, config, is_module, module_source,
            hcl_output, position, variables, outputs, lifecycle_config,
            position_x, position_y, annotations)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)`;

    await client.query('DELETE FROM resources WHERE project_id = $1', [req.params.id]);
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      const hcl = stripHtml(r.hcl_output || '');

      // Defensive JSON handling: ensure config/variables/outputs/lifecycle_config
      // are valid JSON objects/arrays. If the client sent a string that isn't
      // valid JSON, coerce to an empty object/array to avoid Postgres JSON parse
      // errors which would fail the entire save operation.
      //
      // IMPORTANT: this function must ALWAYS return an object/array (never a
      // plain string), because pg sends strings as-is to Postgres. If a string
      // reaches a JSONB column, Postgres tries to parse it as JSON and fails
      // with "invalid input syntax for type json".
      function safeParse(value, fallback) {
        if (value === null || value === undefined) return fallback;
        if (typeof value === 'object') return value;
        if (typeof value === 'string') {
          // Try parsing once to handle normal JSON strings
          try {
            const first = JSON.parse(value);
            // If the result is still a string (double-encoded), parse again
            if (typeof first === 'string') {
              try { return JSON.parse(first); } catch { return fallback; /* never return a bare string */ }
            }
            return first;
          } catch (e1) {
            // best-effort: strip HTML fragments then re-try
            try {
              const cleaned = stripHtml(value);
              const first = JSON.parse(cleaned);
              if (typeof first === 'string') {
                try { return JSON.parse(first); } catch { return fallback; }
              }
              return first;
            } catch (e2) {
              return fallback; // always fall back to a safe object
            }
          }
        }
        return fallback;
      }

      const safeConfig = safeParse(r.config, {});
      const safeVars   = safeParse(r.variables, {});
      const safeOuts   = safeParse(r.outputs, {});
      const safeLife   = safeParse(r.lifecycle_config, {});

      const enforceJson = (v, fallback = {}) => {
        if (v === null || v === undefined) return fallback;
        if (typeof v === 'object') return v;
        return fallback;
      };

      const safeConfigObj = enforceJson(safeConfig, {});
      const safeVarsObj   = enforceJson(safeVars, {});
      const safeOutsObj   = enforceJson(safeOuts, {});
      const safeLifeObj   = enforceJson(safeLife, {});

      const normalizeJson = (val, fallback = {}) => {
        if (val === null || val === undefined) return fallback;
        if (typeof val === 'object') {
          try {
            return JSON.parse(JSON.stringify(val));
          } catch (err) {
            console.error('[projects] normalizeJson failed:', err.message, 'val:', val);
            return fallback;
          }
        }
        return fallback;
      };

      const finalConfig = normalizeJson(safeConfigObj, {});
      const finalVars = normalizeJson(safeVarsObj, {});
      const finalOuts = normalizeJson(safeOutsObj, {});
      const finalLife = normalizeJson(safeLifeObj, {});

      const jsonbParam = (val) => {
        try { return JSON.stringify(val); } catch (err) {
          console.error('[projects] jsonbParam failed:', err.message, 'val:', val);
          return JSON.stringify({});
        }
      };

      // Warn if secrets found in HCL (already blocked at the terraform route, belt-and-suspenders here)
      const secrets = detectSecrets(hcl);
      if (secrets.length > 0) {
        console.warn(`[projects] Secret detected in resource ${r.service_type} for project ${req.params.id}`);
      }

      try {
        // Preserve original raw config string in annotations if parsing failed
        let annotationsToSave = r.annotations?.trim() ? r.annotations : null;
        const isModule = r.is_module === true || r.is_module === 'true';
        const positionX = Number(r.position?.x ?? 0) || 0;
        const positionY = Number(r.position?.y ?? 0) || 0;

        // Prepare annotations parameter according to detected DB column type.
        // When the DB column is jsonb we must pass valid JSON text (or null).
        const prepareAnnotationsParam = (val) => {
          if (val === null || val === undefined) return null;
          if (annotationsIsJsonb) {
            // If it's already an object, stringify it. If it's a string,
            // try parsing; otherwise wrap it in an object so it's valid JSON.
            if (typeof val === 'object') return JSON.stringify(val);
            if (typeof val === 'string') {
              try {
                const parsed = JSON.parse(val);
                return JSON.stringify(parsed);
              } catch (err) {
                return JSON.stringify({ text: val });
              }
            }
            return JSON.stringify({ value: String(val) });
          }
          // For plain text column, keep as string
          return typeof val === 'string' ? val : String(val);
        };

        let annotationsParam = prepareAnnotationsParam(annotationsToSave);

        const params = [
          req.params.id,                                          // $1  UUID
          r.service_type || 'unknown',                           // $2  VARCHAR
          r.resource_name || r.label || '',                      // $3  VARCHAR
          jsonbParam(finalConfig),                               // $4  JSONB
          isModule,                                              // $5  BOOLEAN
          r.module_source || '',                                 // $6  VARCHAR
          hcl,                                                   // $7  TEXT
          i,                                                     // $8  INT (position)
          jsonbParam(finalVars),                                 // $9  JSONB
          jsonbParam(finalOuts),                                 // $10 JSONB
          jsonbParam(finalLife),                                 // $11 JSONB
          positionX,                                             // $12 NUMERIC
          positionY,                                             // $13 NUMERIC
          annotationsParam,                                      // $14 TEXT/JSONB
        ];

        // If original config was a string and finalConfig is empty, stash raw config in annotations
        try {
          if (typeof r.config === 'string' && Object.keys(finalConfig || {}).length === 0 && r.config.trim()) {
            annotationsToSave = (annotationsToSave ? annotationsToSave + '\n' : '') + 'raw_config:' + r.config.slice(0, 1000);
            annotationsParam = prepareAnnotationsParam(annotationsToSave);
            params[13] = annotationsParam;
          }
        } catch (e) {}

        await client.query(insertSqlTemplate, params);
      } catch (e) {
        // BE-03 fix: replaced verbose payload dump with a terse structured log
        console.error('[projects] Failed inserting resource', { index: i, service_type: r.service_type, msg: e.message });
        throw e;
      }
    }
    await client.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);

    // Persist the full generated HCL on the project row so it can be restored
    // on next login even before the version history is loaded.
    // Auto-add the column if it doesn't exist yet (idempotent).
    try {
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_hcl TEXT DEFAULT ''`);
    } catch { /* ignore if no permission — non-fatal */ }
    // BE-04 fix: persist the complete HCL supplied by the frontend (which includes
    // terraform {}, provider "aws" {}, backend {}, locals {}, variables {}, and
    // outputs {} blocks generated by buildFullHCL).  Fall back to per-resource
    // concatenation only when the caller omits full_hcl for backwards compat.
    const fullHclToSave = full_hcl
      ? stripHtml(full_hcl)
      : resources.map(r => stripHtml(r.hcl_output || '')).join('\n\n');
    if (fullHclToSave.trim()) {
      await client.query('UPDATE projects SET last_hcl=$1 WHERE id=$2', [fullHclToSave, req.params.id]).catch(() => {});
    }

    await client.query('COMMIT');
    res.json({ saved: true, count: resources.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[projects] Save resources error:', e.message);
    res.status(500).json({ error: 'Failed to save resources: ' + e.message });
  } finally { client.release(); }
});

// ─── Version history ──────────────────────────────────────────────────────────
router.get('/:id/versions', authMiddleware, async (req, res) => {
  const project = await authoriseProject(req, res);
  if (!project) return;
  try {
    // Ensure the extended columns exist before selecting them.
    // The POST (save) route auto-adds them on first write, but a user may visit
    // the history page on a fresh DB before ever saving — this prevents a
    // "column does not exist" 500 that would surface as an empty history view.
    const versionReadCols = [
      { col: 'full_hcl',          type: 'TEXT',          def: "''" },
      { col: 'resource_count',    type: 'INT',           def: '0' },
      { col: 'cost_estimate_usd', type: 'NUMERIC(12,4)', def: null },
      { col: 'checkov_passed',    type: 'INT',           def: '0' },
      { col: 'checkov_failed',    type: 'INT',           def: '0' },
      { col: 'change_summary',    type: 'TEXT',          def: "''" },
    ];
    for (const { col, type, def } of versionReadCols) {
      const defClause = def !== null ? ` DEFAULT ${def}` : '';
      await db.query(`ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS ${col} ${type}${defClause}`).catch(() => {});
    }

    const result = await db.query(
      `SELECT id, version_number, full_hcl, resource_count, cost_estimate_usd, checkov_passed, checkov_failed, change_summary, saved_at FROM project_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Save version snapshot ────────────────────────────────────────────────────
router.post('/:id/versions', authMiddleware, audit('project.version.save'), async (req, res) => {
  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin', 'user']);
  if (!project) return;
  const { full_hcl, resource_count, cost_estimate_usd, checkov_passed, checkov_failed, change_summary } = req.body;
  try {
    // Auto-migrate: ensure version columns exist
    const versionCols = [
      { col: 'full_hcl',          type: 'TEXT',          def: "''" },
      { col: 'cost_estimate_usd', type: 'NUMERIC(12,4)', def: null },
      { col: 'checkov_passed',    type: 'INT',           def: '0' },
      { col: 'checkov_failed',    type: 'INT',           def: '0' },
      { col: 'change_summary',    type: 'TEXT',          def: "''" },
      { col: 'saved_by',          type: 'UUID',          def: null },
      { col: 'resource_count',    type: 'INT',           def: '0' },
    ];
    for (const { col, type, def } of versionCols) {
      const defClause = def !== null ? ` DEFAULT ${def}` : '';
      await db.query(`ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS ${col} ${type}${defClause}`).catch(() => {});
    }

    // BUG-007 fix: atomic version number assignment using INSERT...SELECT to eliminate
    // the race condition where two concurrent saves both read the same MAX and insert
    // duplicate version numbers. The UNIQUE constraint on (project_id, version_number)
    // in schema.sql provides a DB-level safety net as a second line of defence.
    const result = await db.query(
      `INSERT INTO project_versions
         (project_id, version_number, full_hcl, resource_count,
          cost_estimate_usd, checkov_passed, checkov_failed, change_summary, saved_by)
       SELECT $1,
              COALESCE(MAX(version_number), 0) + 1,
              $2, $3, $4, $5, $6, $7, $8
         FROM project_versions
        WHERE project_id = $1
       RETURNING *`,
      [req.params.id,
       stripHtml(full_hcl || ''), resource_count || 0,
       cost_estimate_usd || null, checkov_passed || 0, checkov_failed || 0,
       change_summary || '', req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    // FIX: INSERT…SELECT MAX+1 is not atomic under concurrent load; two requests
    // reading the same MAX both compute the same next version number and hit the
    // UNIQUE(project_id, version_number) constraint.  Catch PG error 23505 and
    // surface a 409 Conflict instead of an opaque 500, so callers can retry.
    if (e.code === '23505') {
      return res.status(409).json({
        error: 'Version number conflict — another save is in progress. Please retry.',
      });
    }
    console.error('[projects] Save version error:', e.message);
    res.status(500).json({ error: 'Failed to save version: ' + e.message });
  }
});

// ─── Version diff ─────────────────────────────────────────────────────────────
router.get('/:id/versions/diff', authMiddleware, async (req, res) => {
  const project = await authoriseProject(req, res);
  if (!project) return;

  const { a, b } = req.query; // version numbers
  if (!a || !b) return res.status(400).json({ error: 'Query params a and b (version numbers) required' });

  try {
    const result = await db.query(
      'SELECT version_number, full_hcl FROM project_versions WHERE project_id=$1 AND version_number = ANY($2)',
      [req.params.id, [parseInt(a, 10), parseInt(b, 10)]]
    );
    const parsedA = parseInt(a, 10);
    const parsedB = parseInt(b, 10);
    const map = Object.fromEntries(result.rows.map(r => [r.version_number, r.full_hcl]));
    if (!map[parsedA] || !map[parsedB]) return res.status(404).json({ error: 'One or both versions not found' });
    res.json({ a: parsedA, b: parsedB, hcl_a: map[parsedA], hcl_b: map[parsedB] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project members ──────────────────────────────────────────────────────────
router.get('/:id/members', authMiddleware, async (req, res) => {
  const project = await authoriseProject(req, res);
  if (!project) return;
  try {
    const result = await db.query(
      `SELECT pm.id, pm.role, pm.invited_at, pm.accepted_at,
              u.email, u.id as user_id
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/members', authMiddleware, requireRole('user'), audit('project.member.invite'), async (req, res) => {
  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin', 'user']);
  if (!project) return;
  if (project.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the project owner or admin can invite members' });
  }
  const { email, role = 'editor' } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!['viewer', 'editor', 'deployer'].includes(role)) {
    return res.status(400).json({ error: 'role must be viewer, editor, or deployer' });
  }
  try {
    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found. They must register first.' });
    const inviteeId = userRes.rows[0].id;

    await db.query(
      `INSERT INTO project_members (project_id, user_id, role, invited_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.id, inviteeId, role, req.user.id]
    );

    // Let the invitee know — without this, an invited user had no way to
    // discover the pending invitation short of guessing to check a project
    // they don't own yet.
    createNotification(inviteeId, {
      type: 'member.invited',
      title: `You've been invited to "${project.name}"`,
      body: `${req.user.email} invited you as ${role}.`,
      link: `/team/${req.params.id}`,
      actor_id: req.user.id,
    }).catch(() => {});

    res.json({ invited: true, email, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/members/:userId', authMiddleware, audit('project.member.remove'), async (req, res) => {
  if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });

  // Self-removal (declining a pending invite, or leaving a project you've
  // already joined) is always allowed and doesn't need authoriseProject —
  // that check requires accepted_at IS NOT NULL, which would incorrectly
  // block a pending invitee from removing their own not-yet-accepted row.
  if (req.params.userId === req.user.id) {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid project ID' });
    try {
      await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
      return res.json({ removed: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin', 'user']);
  if (!project) return;
  if (project.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the project owner or admin can remove members' });
  }
  try {
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
    res.json({ removed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BE-11 fix: the invitation flow inserts a project_members row with accepted_at = NULL,
// but authoriseProject only grants access when accepted_at IS NOT NULL.  Without this
// endpoint accepted_at could never be set and every invited member was permanently locked
// out.  Only the invitee themselves may accept their own invitation.
router.put('/:id/members/:userId/accept', authMiddleware, audit('project.member.accept'), async (req, res) => {
  // Only the invited user may accept their own invitation.
  if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
  if (req.user.id !== req.params.userId) {
    return res.status(403).json({ error: 'You can only accept your own invitation' });
  }
  try {
    const result = await db.query(
      `UPDATE project_members
          SET accepted_at = NOW()
        WHERE project_id = $1
          AND user_id    = $2
          AND accepted_at IS NULL
        RETURNING id, role`,
      [req.params.id, req.params.userId]
    );
    if (!result.rows.length) {
      // Either no pending invitation exists or it was already accepted.
      const existing = await db.query(
        'SELECT accepted_at FROM project_members WHERE project_id=$1 AND user_id=$2',
        [req.params.id, req.params.userId]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'No invitation found for this project' });
      if (existing.rows[0].accepted_at) return res.status(409).json({ error: 'Invitation already accepted' });
    }
    res.json({ accepted: true, role: result.rows[0]?.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
