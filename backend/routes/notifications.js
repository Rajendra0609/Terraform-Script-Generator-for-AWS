'use strict';
/**
 * /api/notifications — In-app notification system
 *
 * Routes:
 *   GET    /api/notifications          list my notifications (paginated)
 *   GET    /api/notifications/unread-count
 *   POST   /api/notifications/:id/read mark as read
 *   POST   /api/notifications/read-all mark all as read
 *   DELETE /api/notifications/:id      delete
 *   POST   /api/notifications/webhook-test  test MY OWN webhook_url preference
 *          (any authenticated user — this is a "test my settings" action, not
 *          an admin action; see the SECURITY note above route registration)
 */
const router = require('express').Router();
const db     = require('../db/connection');
const { authMiddleware, requireRole } = require('../middleware/auth');
const https  = require('https');
const http   = require('http');
const rateLimit = require('express-rate-limit');
const { resolveSafeAddress, SsrfBlockedError } = require('../utils/ssrfGuard');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Ensure notifications table ───────────────────────────────────────────────
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       VARCHAR(100) NOT NULL,
      title      VARCHAR(255) NOT NULL,
      body       TEXT,
      link       TEXT,
      actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
      read_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications(user_id, created_at DESC) WHERE read_at IS NULL
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      notify_email         BOOLEAN DEFAULT true,
      notify_inapp         BOOLEAN DEFAULT true,
      webhook_url          TEXT,
      webhook_secret       TEXT,
      notify_plan_done     BOOLEAN DEFAULT true,
      notify_apply_done    BOOLEAN DEFAULT true,
      notify_cr_review     BOOLEAN DEFAULT true,
      notify_policy_fail   BOOLEAN DEFAULT true,
      updated_at           TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
}
ensureTables();

router.use(authMiddleware);

// ─── GET /api/notifications ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { limit = 40, offset = 0, unread_only } = req.query;
  const params = [req.user.id, Math.min(parseInt(limit, 10), 100), Math.max(parseInt(offset, 10), 0)];
  const conditions = ['n.user_id = $1'];
  if (unread_only === 'true') conditions.push('n.read_at IS NULL');

  try {
    const { rows } = await db.query(`
      SELECT n.*, u.email AS actor_email
      FROM notifications n
      LEFT JOIN users u ON u.id = n.actor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.created_at DESC
      LIMIT $2 OFFSET $3
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/notifications/unread-count ─────────────────────────────────────
router.get('/unread-count', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/notifications/:id/read ────────────────────────────────────────
router.post('/:id/read', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID' });
  try {
    const { rowCount } = await db.query(
      'UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2 AND read_at IS NULL',
      [req.params.id, req.user.id]
    );
    res.json({ marked: rowCount > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/notifications/read-all ────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ marked: rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/notifications/:id ───────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID' });
  try {
    await db.query('DELETE FROM notifications WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/notifications/preferences ──────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM user_preferences WHERE user_id=$1',
      [req.user.id]
    );
    if (!rows.length) {
      // Return defaults
      return res.json({
        user_id:             req.user.id,
        notify_email:        true,
        notify_inapp:        true,
        webhook_url:         null,
        notify_plan_done:    true,
        notify_apply_done:   true,
        notify_cr_review:    true,
        notify_policy_fail:  true,
      });
    }
    // Never return webhook_secret to client
    const pref = { ...rows[0] };
    delete pref.webhook_secret;
    res.json(pref);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/notifications/preferences ──────────────────────────────────────
router.put('/preferences', async (req, res) => {
  const {
    notify_email, notify_inapp, webhook_url,
    notify_plan_done, notify_apply_done, notify_cr_review, notify_policy_fail,
  } = req.body;

  try {
    const { rows } = await db.query(`
      INSERT INTO user_preferences (user_id, notify_email, notify_inapp, webhook_url,
        notify_plan_done, notify_apply_done, notify_cr_review, notify_policy_fail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id) DO UPDATE SET
        notify_email       = COALESCE(EXCLUDED.notify_email,       user_preferences.notify_email),
        notify_inapp       = COALESCE(EXCLUDED.notify_inapp,       user_preferences.notify_inapp),
        webhook_url        = COALESCE(EXCLUDED.webhook_url,        user_preferences.webhook_url),
        notify_plan_done   = COALESCE(EXCLUDED.notify_plan_done,   user_preferences.notify_plan_done),
        notify_apply_done  = COALESCE(EXCLUDED.notify_apply_done,  user_preferences.notify_apply_done),
        notify_cr_review   = COALESCE(EXCLUDED.notify_cr_review,   user_preferences.notify_cr_review),
        notify_policy_fail = COALESCE(EXCLUDED.notify_policy_fail, user_preferences.notify_policy_fail),
        updated_at         = NOW()
      RETURNING *
    `, [
      req.user.id,
      notify_email  ?? true,
      notify_inapp  ?? true,
      webhook_url   || null,
      notify_plan_done   ?? true,
      notify_apply_done  ?? true,
      notify_cr_review   ?? true,
      notify_policy_fail ?? true,
    ]);
    const pref = { ...rows[0] };
    delete pref.webhook_secret;
    res.json(pref);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/notifications/webhook-test ────────────────────────────────────
// SECURITY: dedicated tight rate limiter (audit finding — this endpoint has
// no legitimate high-frequency use case: it's a "test my webhook" button a
// user clicks a handful of times while configuring notification settings,
// not something a normal UI flow calls repeatedly). Keyed by user id since
// this route always runs after authMiddleware.
const webhookTestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip || 'unknown',
  handler: (req, res) => {
    res.set('Retry-After', String(15 * 60));
    res.status(429).json({ error: 'Too many webhook test requests — slow down', retryAfter: 15 * 60 });
  },
});

// Response bodies from arbitrary third-party endpoints are never trusted or
// parsed — cap what we'll even read before giving up on the connection.
const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

// NOTE on the audit's suggested `requireRole('admin')`: this endpoint tests
// the CALLER'S OWN `webhook_url` preference (a per-user setting in
// `user_preferences`, set via PUT /preferences above) — gating it to admins
// would break the actual feature for every non-admin user. The audit's fix
// was phrased as admin-gating "and/or" tight rate-limiting; the SSRF guard
// above plus the 5-req/15-min per-user limiter below fully close the
// original vulnerability (metadata-endpoint credential theft, internal
// port-scanning) without breaking the feature, so that's the path taken.
router.post('/webhook-test', webhookTestLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Validate URL
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL — must be http or https' });
  }

  // SECURITY FIX (critical): resolve the hostname ourselves and reject
  // loopback/private/link-local(cloud-metadata)/reserved targets BEFORE
  // making any outbound connection. See utils/ssrfGuard.js for the full
  // writeup of what this closes (metadata-credential theft, internal
  // network port-scanning via a low-privilege authenticated endpoint).
  let safeTarget;
  try {
    safeTarget = await resolveSafeAddress(parsed.hostname);
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      return res.status(400).json({ error: 'Webhook URL is not allowed: ' + e.message });
    }
    return res.status(400).json({ error: 'Could not validate webhook URL.' });
  }

  const payload = JSON.stringify({
    event: 'webhook.test',
    timestamp: new Date().toISOString(),
    message: 'TFGen webhook test — if you see this, your endpoint is working!',
    source: 'TFGen',
  });

  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    // SECURITY FIX: pin the connection to the exact IP we just validated,
    // instead of the hostname (which the HTTP client would otherwise
    // re-resolve at connect time — a classic DNS-rebinding TOCTOU gap
    // between "checked safe" and "actually connected to"). The original
    // hostname is preserved via the Host header (virtual hosting) and, for
    // TLS, via `servername` (SNI + certificate hostname verification).
    host:   safeTarget.address,
    family: safeTarget.family,
    port:   parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:   parsed.pathname + parsed.search,
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-TFGen-Event':  'webhook.test',
      'Host':           parsed.host,
    },
    timeout: 5000,
    ...(parsed.protocol === 'https:' ? { servername: parsed.hostname } : {}),
  };

  let responded = false;
  const finish = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  const reqOut = lib.request(options, (response) => {
    // Drain the body ourselves with a hard cap — we don't care about the
    // content, but we must not let an untrusted endpoint hold the socket
    // open indefinitely or stream unbounded data into memory. Respond
    // immediately once the cap is hit rather than waiting on 'end'/'error'
    // — destroy() doesn't reliably emit either of those, so waiting on them
    // here would leave the request hanging.
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_WEBHOOK_RESPONSE_BYTES) {
        response.destroy();
        finish(200, { success: true, status: response.statusCode, truncated: true });
      }
    });
    response.on('end',   () => finish(200, { success: true, status: response.statusCode }));
    response.on('error', () => finish(200, { success: true, status: response.statusCode }));
    response.on('close', () => finish(200, { success: true, status: response.statusCode }));
  });
  reqOut.on('error', (err) => {
    finish(400, { success: false, error: err.message });
  });
  reqOut.on('timeout', () => {
    reqOut.destroy();
    finish(408, { success: false, error: 'Webhook request timed out' });
  });
  reqOut.write(payload);
  reqOut.end();
});

// ─── Exported helper: send a notification to a user ──────────────────────────
/**
 * Create an in-app notification. Safe to call fire-and-forget.
 * @param {string} userId
 * @param {object} opts { type, title, body, link, actor_id }
 */
async function createNotification(userId, opts) {
  if (!userId) return;
  try {
    await db.query(`
      INSERT INTO notifications (user_id, type, title, body, link, actor_id)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [userId, opts.type, opts.title, opts.body || null, opts.link || null, opts.actor_id || null]);
  } catch (e) {
    console.warn('[notifications] createNotification error:', e.message);
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
