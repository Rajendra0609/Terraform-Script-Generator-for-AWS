'use strict';
/**
 * Shared project-access authorization helper.
 *
 * Extracted from routes/projects.js so any route that needs to check
 * "does this user own/belong to this project, with at least role X"
 * (terraform.js /apply, future policy/admin routes, etc.) uses the exact
 * same logic instead of re-implementing project_members lookups.
 */
const db = require('../db/connection');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check that the requesting user owns or is a member of the project with
 * a sufficient role. Returns the project row (with `_memberRole` attached
 * when access came from project_members rather than ownership), or sends
 * 400/403/404 and returns null.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string[]} allowedRoles - roles from project_members that are
 *   sufficient for this action. The project owner always has access
 *   regardless of this list.
 */
async function authoriseProject(req, res, allowedRoles = ['viewer', 'editor', 'deployer', 'admin', 'user']) {
  const { id } = req.params;
  const userId  = req.user?.id;

  // Guard: reject before hitting DB to avoid "invalid input syntax for type uuid" errors
  if (!id || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid or missing project ID' });
    return null;
  }

  const proj = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!proj.rows.length) { res.status(404).json({ error: 'Project not found' }); return null; }

  const project = proj.rows[0];
  // Owner always has access
  if (project.user_id === userId) return project;

  // Check project_members table
  const member = await db.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL',
    [id, userId]
  );
  if (!member.rows.length) { res.status(403).json({ error: 'Access denied' }); return null; }

  const memberRole = member.rows[0].role;
  if (!allowedRoles.includes(memberRole)) {
    res.status(403).json({ error: `Insufficient role. Required one of: ${allowedRoles.join(', ')}` });
    return null;
  }
  return { ...project, _memberRole: memberRole };
}

/**
 * Variant of authoriseProject() for routes that take the project id from
 * the request body instead of the URL params (e.g. POST /api/terraform/apply
 * where the HCL + project_id are both in the body).
 */
async function authoriseProjectById(req, res, projectId, allowedRoles = ['viewer', 'editor', 'deployer', 'admin', 'user']) {
  const fakeReq = { ...req, params: { ...req.params, id: projectId } };
  return authoriseProject(fakeReq, res, allowedRoles);
}

/**
 * Check whether `userId` may read the given execution job (own job, or a
 * job on a project they own/are an accepted member of). Boolean-returning
 * (no req/res) so it can be reused outside Express route handlers — e.g.
 * the /ws/jobs WebSocket connection handler in server.js, which previously
 * had NO access check at all: any client that knew a jobId got a live
 * subscription to that job's terraform plan/apply output. Mirrors the SQL
 * already used by GET /api/terraform/jobs/:jobId.
 */
async function hasJobAccess(jobId, userId) {
  if (!jobId || !UUID_RE.test(jobId) || !userId) return false;
  const row = await db.query(
    `SELECT 1
       FROM execution_jobs ej
      WHERE ej.id = $1
        AND (ej.user_id = $2 OR EXISTS (
              SELECT 1 FROM projects p
              LEFT JOIN project_members pm
                ON pm.project_id = p.id AND pm.user_id = $2 AND pm.accepted_at IS NOT NULL
             WHERE p.id = ej.project_id
               AND (p.user_id = $2 OR pm.user_id IS NOT NULL)
            ))`,
    [jobId, userId]
  );
  return row.rows.length > 0;
}

module.exports = { authoriseProject, authoriseProjectById, hasJobAccess, UUID_RE };
