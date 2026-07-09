'use strict';
/**
 * notify.js — Shared helper to notify everyone attached to a project
 * (owner + accepted members), in-app, optionally by email, and now
 * (L-05 fix) by outbound webhook if the recipient has configured one.
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
 * skipped. Email and webhook delivery are best-effort add-ons: if SMTP
 * isn't configured, a recipient has no webhook_url set, or either send
 * fails, the in-app notification still lands and the caller is never
 * blocked or made to fail because of it.
 */
const db = require('../db/connection');
const { deliverWebhook } = require('../utils/webhookDelivery');

// Maps a notification `type` (as passed by callers below) to the
// user_preferences column that gates whether that event should fire a
// webhook for a given recipient. Unrecognized/future types default to "no
// gating column" (webhookEnabledForType() below then just requires
// webhook_url to be set), rather than silently never delivering.
function preferenceColumnForType(type) {
  if (!type) return null;
  if (type.startsWith('apply.'))           return 'notify_apply_done';
  if (type.startsWith('plan.'))            return 'notify_plan_done';
  if (type.startsWith('change_request.'))  return 'notify_cr_review';
  if (type.startsWith('checkov.') || type.startsWith('policy.')) return 'notify_policy_fail';
  return null;
}

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

    // ── Webhook fan-out (L-05 fix) ─────────────────────────────────────────
    // Best-effort and fire-and-forget, same as email above: look up each
    // recipient's own webhook_url/webhook_secret/notify_* preferences and
    // deliver to whoever has one configured and enabled for this event type.
    // Never awaited by the caller — a slow or dead third-party endpoint must
    // never delay a plan/apply response or an in-app notification.
    (async () => {
      try {
        const prefCol = preferenceColumnForType(notification.type);
        const targetIds = recipients
          .filter(r => r.user_id !== notification.actor_id)
          .map(r => r.user_id);
        if (!targetIds.length) return;

        const { rows: prefs } = await db.query(
          `SELECT user_id, webhook_url, webhook_secret,
                  notify_plan_done, notify_apply_done, notify_cr_review, notify_policy_fail
             FROM user_preferences
            WHERE user_id = ANY($1::uuid[]) AND webhook_url IS NOT NULL`,
          [targetIds]
        ).catch(() => ({ rows: [] }));

        const deliveries = prefs
          .filter(p => {
            if (!prefCol) return true; // unrecognized type — no gating column, still deliver
            // Preference flags default to true at the DB level; a NULL here
            // (shouldn't normally happen once a row exists) is treated as
            // enabled rather than silently dropping the event.
            return p[prefCol] !== false;
          })
          .map(p => deliverWebhook({
            url: p.webhook_url,
            secret: p.webhook_secret || null,
            event: {
              type: notification.type,
              title: notification.title,
              body: notification.body || null,
              link: notification.link || null,
              timestamp: new Date().toISOString(),
              source: 'TFGen',
            },
          }).catch(() => {}));

        await Promise.allSettled(deliveries);
      } catch (_) { /* best-effort — webhook delivery must never affect the caller */ }
    })().catch(() => {});

    return notifRows;
  } catch (_) {
    return [];
  }
}

module.exports = { notifyProjectMembers };
