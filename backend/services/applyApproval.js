'use strict';
/**
 * Approval gate for `terraform apply`.
 *
 * Enabled with APPLY_REQUIRES_APPROVAL=true (off by default so existing
 * deployments keep working; recommended for production). When enabled, apply
 * is refused unless the request carries change_request_id and that change
 * request:
 *   1. belongs to the same project,
 *   2. has been approved (status approved or merged),
 *   3. was approved by someone other than the user applying (separation of duties),
 *   4. was approved for exactly this HCL: the SHA-256 of the submitted HCL must
 *      match the SHA-256 of the reviewed project version.
 *
 * Returns { ok: true } or { ok: false, status, code, error }.
 */
const crypto = require('crypto');
const db = require('../db/connection');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function approvalRequired() {
  return process.env.APPLY_REQUIRES_APPROVAL === 'true';
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

const refuse = (status, code, error) => ({ ok: false, status, code, error });

async function checkApplyApproval({ projectId, changeRequestId, applierId, hcl }) {
  if (!approvalRequired()) return { ok: true, gate: 'disabled' };

  if (!changeRequestId || !UUID_RE.test(String(changeRequestId))) {
    return refuse(403, 'APPROVAL_REQUIRED',
      'This project requires an approved change request before apply. Send change_request_id.');
  }

  const { rows } = await db.query(
    `SELECT cr.id, cr.project_id, cr.status, cr.approved_by, v.full_hcl
       FROM change_requests cr
       JOIN project_versions v ON v.id = cr.version_id
      WHERE cr.id = $1`,
    [changeRequestId]
  );
  const cr = rows[0];
  // One generic message for "missing" and "belongs to another project", so the
  // endpoint does not reveal which change request IDs exist.
  if (!cr || cr.project_id !== projectId) {
    return refuse(403, 'APPROVAL_NOT_FOUND', 'That change request is not available for this project.');
  }
  if (cr.status !== 'approved' && cr.status !== 'merged') {
    return refuse(409, 'APPROVAL_NOT_APPROVED',
      `Change request is "${cr.status}". Only approved change requests can be applied.`);
  }
  if (cr.approved_by && cr.approved_by === applierId) {
    return refuse(403, 'SELF_APPROVAL_FORBIDDEN',
      'The person who approved a change cannot also apply it. Ask another approver to apply.');
  }
  if (sha256(hcl) !== sha256(cr.full_hcl)) {
    return refuse(409, 'HCL_DIFFERS_FROM_APPROVED',
      'The HCL being applied is not the version that was approved. Save a new version, request review, and apply that.');
  }
  return { ok: true, gate: 'enforced', changeRequestId: cr.id };
}

module.exports = { checkApplyApproval, approvalRequired, sha256, UUID_RE };
