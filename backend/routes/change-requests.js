'use strict';
/**
 * /api/change-requests  — PR-style review workflow
 *
 * Change requests allow teams to gate terraform applies behind a review step.
 * Flow: Author creates a CR → Reviewers approve/reject → apply is unblocked.
 *
 * Routes:
 *   GET    /api/change-requests                  list all CRs (admin/deployer)
 *   GET    /api/change-requests/project/:pid     list CRs for a project
 *   GET    /api/change-requests/:id              get single CR
 *   POST   /api/change-requests                  create CR (submit for review)
 *   POST   /api/change-requests/:id/approve      approve CR (deployer/admin)
 *   POST   /api/change-requests/:id/reject       reject CR  (deployer/admin)
 *   POST   /api/change-requests/:id/merge        mark as merged after apply
 *   DELETE /api/change-requests/:id              withdraw (author or admin)
 *   GET    /api/change-requests/:id/comments     list comments
 *   POST   /api/change-requests/:id/comments     add comment
 */
const router   = require('express').Router();
const db       = require('../db/connection');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { authoriseProject } = require('../utils/projectAccess');
const { notifyProjectMembers } = require('../services/notify');
const { sendChangeRequestSubmitted } = require('../services/mailer');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Ensure tables exist ──────────────────────────────────────────────────────
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS change_requests (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
      version_id  UUID REFERENCES project_versions(id) ON DELETE CASCADE,
      author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
      title       VARCHAR(255),
      description TEXT,
      status      VARCHAR(50) DEFAULT 'open',
      approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMP,
      rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
      rejected_at TIMESTAMP,
      reject_reason TEXT,
      merged_at   TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS change_request_comments (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
      author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      body              TEXT NOT NULL,
      created_at        TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cr_project ON change_requests(project_id, created_at DESC)
  `).catch(() => {});
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cr_author ON change_requests(author_id)
  `).catch(() => {});
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests(status)
  `).catch(() => {});
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_cr_comments ON change_request_comments(change_request_id, created_at)
  `).catch(() => {});
}
ensureTables();

router.use(authMiddleware);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const CR_SELECT = `
  SELECT
    cr.*,
    u_author.email  AS author_email,
    u_approver.email AS approved_by_email,
    u_rejector.email AS rejected_by_email,
    p.name          AS project_name,
    pv.version_number
  FROM change_requests cr
  LEFT JOIN users u_author   ON u_author.id   = cr.author_id
  LEFT JOIN users u_approver ON u_approver.id = cr.approved_by
  LEFT JOIN users u_rejector ON u_rejector.id = cr.rejected_by
  LEFT JOIN projects p       ON p.id          = cr.project_id
  LEFT JOIN project_versions pv ON pv.id      = cr.version_id
`;

async function loadCR(id) {
  const { rows } = await db.query(`${CR_SELECT} WHERE cr.id = $1`, [id]);
  return rows[0] || null;
}

// ─── GET /api/change-requests ─────────────────────────────────────────────────
router.get('/', requireRole('user'), async (req, res) => {
  const { status, project_id, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  // Non-admins only see CRs for their own projects or where they're a member
  if (req.user.role !== 'admin') {
    params.push(req.user.id);
    conditions.push(`(
      cr.project_id IN (SELECT id FROM projects WHERE user_id = $${params.length})
      OR cr.project_id IN (SELECT project_id FROM project_members WHERE user_id = $${params.length} AND accepted_at IS NOT NULL)
      OR cr.author_id = $${params.length}
    )`);
  }

  if (status) { params.push(status); conditions.push(`cr.status = $${params.length}`); }
  if (project_id && UUID_RE.test(project_id)) {
    params.push(project_id);
    conditions.push(`cr.project_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(limit, 10), 200));
  params.push(Math.max(parseInt(offset, 10), 0));

  try {
    const { rows } = await db.query(
      `${CR_SELECT} ${where} ORDER BY cr.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/change-requests/project/:projectId ──────────────────────────────
router.get('/project/:projectId', async (req, res) => {
  if (!UUID_RE.test(req.params.projectId)) return res.status(400).json({ error: 'Invalid project ID' });

  // Verify project access
  req.params.id = req.params.projectId;
  const project = await authoriseProject(req, res);
  if (!project) return;

  try {
    const { rows } = await db.query(
      `${CR_SELECT} WHERE cr.project_id = $1 ORDER BY cr.created_at DESC LIMIT 100`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/change-requests/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });
  try {
    const cr = await loadCR(req.params.id);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });

    // Access check: must be author, project member, or admin
    const isAdmin    = req.user.role === 'admin';
    const isAuthor   = cr.author_id === req.user.id;
    const memberRes  = await db.query(
      'SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL',
      [cr.project_id, req.user.id]
    );
    const isMember = memberRes.rows.length > 0;
    const ownerRes = await db.query('SELECT 1 FROM projects WHERE id=$1 AND user_id=$2', [cr.project_id, req.user.id]);
    const isOwner  = ownerRes.rows.length > 0;

    if (!isAdmin && !isAuthor && !isMember && !isOwner) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(cr);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/change-requests ────────────────────────────────────────────────
router.post('/', requireRole('user'), audit('change_request.create'), async (req, res) => {
  const { project_id, version_id, title, description } = req.body;

  if (!project_id || !version_id) {
    return res.status(400).json({ error: 'project_id and version_id are required' });
  }
  if (!UUID_RE.test(project_id) || !UUID_RE.test(version_id)) {
    return res.status(400).json({ error: 'Invalid project_id or version_id format' });
  }

  // Verify project access
  req.params.id = project_id;
  const project = await authoriseProject(req, res);
  if (!project) return;

  try {
    // Verify version belongs to project
    const versionRes = await db.query(
      'SELECT id, version_number FROM project_versions WHERE id=$1 AND project_id=$2',
      [version_id, project_id]
    );
    if (!versionRes.rows.length) {
      return res.status(404).json({ error: 'Version not found for this project' });
    }

    // Check no open CR already exists for this version
    const existing = await db.query(
      "SELECT id FROM change_requests WHERE version_id=$1 AND status='open'",
      [version_id]
    );
    if (existing.rows.length) {
      return res.status(409).json({
        error: 'An open change request already exists for this version',
        existing_id: existing.rows[0].id,
      });
    }

    const crTitle = title?.trim() ||
      `CR: ${project.name} v${versionRes.rows[0].version_number}`;

    const { rows } = await db.query(`
      INSERT INTO change_requests (project_id, version_id, author_id, title, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [project_id, version_id, req.user.id, crTitle, description || '']);

    // Notify project owner and members — in-app (source of truth) + best-effort email
    notifyProjectMembers(project_id, {
      type: 'change_request.created',
      title: `New change request: ${crTitle}`,
      body: `${req.user.email} submitted a change request for review.`,
      link: `/builder/${project_id}?tab=changes`,
      actor_id: req.user.id,
    }, {
      email: (toEmail) => sendChangeRequestSubmitted(toEmail, {
        projectId: project_id,
        projectName: project.name,
        title: crTitle,
        actorEmail: req.user.email,
      }),
    }).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/change-requests/:id/approve ────────────────────────────────────
router.post('/:id/approve', requireRole('deployer'), audit('change_request.approve'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });

  try {
    const cr = await loadCR(req.params.id);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });

    if (cr.status !== 'open') {
      return res.status(409).json({ error: `Cannot approve a CR with status '${cr.status}'` });
    }

    // Approver cannot be the same as author (self-approval guard)
    if (cr.author_id === req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot approve your own change request' });
    }

    const { rows } = await db.query(`
      UPDATE change_requests
      SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'open'
      RETURNING *
    `, [req.params.id, req.user.id]);

    if (!rows.length) return res.status(409).json({ error: 'CR already processed' });

    // Add auto-comment
    await db.query(`
      INSERT INTO change_request_comments (change_request_id, author_id, body)
      VALUES ($1, $2, $3)
    `, [req.params.id, req.user.id, req.body.comment || '✅ Approved — ready to apply.']);

    notifyProjectMembers(cr.project_id, {
      type: 'change_request.approved',
      title: `CR Approved: ${cr.title}`,
      body: `${req.user.email} approved the change request. You can now apply.`,
      link: `/builder/${cr.project_id}?tab=changes`,
      actor_id: req.user.id,
    }).catch(() => {});

    res.json(await loadCR(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/change-requests/:id/reject ─────────────────────────────────────
router.post('/:id/reject', requireRole('deployer'), audit('change_request.reject'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });

  const { reason } = req.body;

  try {
    const cr = await loadCR(req.params.id);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });
    if (cr.status !== 'open') {
      return res.status(409).json({ error: `Cannot reject a CR with status '${cr.status}'` });
    }

    const { rows } = await db.query(`
      UPDATE change_requests
      SET status = 'rejected', rejected_by = $2, rejected_at = NOW(),
          reject_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'open'
      RETURNING *
    `, [req.params.id, req.user.id, reason || '']);

    if (!rows.length) return res.status(409).json({ error: 'CR already processed' });

    await db.query(`
      INSERT INTO change_request_comments (change_request_id, author_id, body)
      VALUES ($1, $2, $3)
    `, [req.params.id, req.user.id,
        `❌ Rejected${reason ? `: ${reason}` : '.'}`]);

    notifyProjectMembers(cr.project_id, {
      type: 'change_request.rejected',
      title: `CR Rejected: ${cr.title}`,
      body: `${req.user.email} rejected the change request${reason ? `: ${reason}` : '.'}`,
      link: `/builder/${cr.project_id}?tab=changes`,
      actor_id: req.user.id,
    }).catch(() => {});

    res.json(await loadCR(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/change-requests/:id/merge ──────────────────────────────────────
router.post('/:id/merge', requireRole('deployer'), audit('change_request.merge'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });
  try {
    const { rows } = await db.query(`
      UPDATE change_requests
      SET status = 'merged', merged_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'approved'
      RETURNING *
    `, [req.params.id]);

    if (!rows.length) {
      return res.status(409).json({ error: 'CR must be in "approved" status to merge' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/change-requests/:id ─────────────────────────────────────────
router.delete('/:id', audit('change_request.withdraw'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });
  try {
    const cr = await loadCR(req.params.id);
    if (!cr) return res.status(404).json({ error: 'Change request not found' });

    if (cr.author_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the author or an admin can withdraw a CR' });
    }
    if (!['open', 'rejected'].includes(cr.status)) {
      return res.status(409).json({ error: `Cannot withdraw a CR with status '${cr.status}'` });
    }

    await db.query('DELETE FROM change_requests WHERE id = $1', [req.params.id]);
    res.json({ withdrawn: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Comments ─────────────────────────────────────────────────────────────────
router.get('/:id/comments', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });
  try {
    const { rows } = await db.query(`
      SELECT crc.*, u.email AS author_email
      FROM change_request_comments crc
      LEFT JOIN users u ON u.id = crc.author_id
      WHERE crc.change_request_id = $1
      ORDER BY crc.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/comments', requireRole('user'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid CR ID' });
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comment body is required' });

  try {
    const crExists = await db.query('SELECT id FROM change_requests WHERE id=$1', [req.params.id]);
    if (!crExists.rows.length) return res.status(404).json({ error: 'Change request not found' });

    const { rows } = await db.query(`
      INSERT INTO change_request_comments (change_request_id, author_id, body)
      VALUES ($1, $2, $3)
      RETURNING *, (SELECT email FROM users WHERE id=$2) AS author_email
    `, [req.params.id, req.user.id, body.trim()]);

    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
