'use strict';
/**
 * notify.js — Shared helper to notify everyone attached to a project
 * (owner + accepted members), in-app and optionally by email.
 *
 * This used to be a private copy of the same ~25 lines living inside
 * routes/change-requests.js. Extracting it here means any job type that
 * needs to alert a project's team — Checkov critical findings blocking a
 * plan, a change request being submitted/approved/rejected, a future
 * "apply completed" event — can reuse the same, already-audited fan-out
 * logic instead of re-implementing (and potentially mis-implementing) it.
 *
 * In-app notifications (the `notifications` table, surfaced by the bell
 * icon via /api/notifications) are always the source of truth and are never
 * skipped. Email is a best-effort add-on: if SMTP isn't configured, or a
 * send fails, the in-app notification still lands and the caller is never
 * blocked or made to fail because of it.
 */
const db = require('../db/connection');

/**
 * @param {string} projectId
 * @param {object} notification  { type, title, body, link, actor_id }
 * @param {object} [opts]
 * @param {(toEmail:string, recipient:{user_id:string,email:string})=>Promise} [opts.email]
 *        Optional async function invoked once per recipient (excluding the
 *        actor themselves, so people don't get emailed about their own
 *        action). Rejections are swallowed.
 * @returns {Promise<Array>} the inserted notification rows (best-effort; [] on any failure)
 */
async function notifyProjectMembers(projectId, notification, opts = {}) {
  try {
    const { rows: recipients } = await db.query(`
      SELECT DISTINCT u.id AS user_id, u.email
      FROM (
        SELECT user_id FROM projects WHERE id = $1
        UNION
        SELECT user_id FROM project_members WHERE project_id = $1 AND accepted_at IS NOT NULL
      ) members
      JOIN users u ON u.id = members.user_id
    `, [projectId]);

    if (!recipients.length) return [];

    const { rows: notifRows } = await db.query(`
      INSERT INTO notifications (user_id, type, title, body, link, actor_id)
      SELECT u.id, $1, $2, $3, $4, $5
      FROM unnest($6::uuid[]) AS u(id)
      RETURNING id
    `, [
      notification.type,
      notification.title,
      notification.body,
      notification.link || null,
      notification.actor_id || null,
      recipients.map(r => r.user_id),
    ]).catch(() => ({ rows: [] }));

    if (typeof opts.email === 'function') {
      // Fire-and-forget — an email provider outage must never affect the
      // in-app notification path or the caller's HTTP response.
      Promise.allSettled(
        recipients
          .filter(r => r.user_id !== notification.actor_id)
          .map(r => opts.email(r.email, r).catch(() => {}))
      ).catch(() => {});
    }

    return notifRows;
  } catch (_) {
    return [];
  }
}

module.exports = { notifyProjectMembers };
