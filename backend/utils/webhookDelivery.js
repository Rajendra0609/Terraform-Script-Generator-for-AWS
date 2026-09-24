'use strict';
/**
 * FEATURE/SECURITY FIX (L-05): user_preferences.webhook_url/webhook_secret
 * were configurable via GET/PUT /api/notifications/preferences and "tested"
 * via POST /api/notifications/webhook-test, but nothing ever consulted the
 * SAVED preference to actually deliver a real-event notification — a user
 * who configured a webhook expecting to be notified on plan/apply/CR events
 * would simply never receive anything, with no error or indication the
 * feature wasn't implemented. This module is that missing delivery path.
 *
 * It mirrors the SSRF hardening already applied to the interactive
 * webhook-test endpoint (routes/notifications.js / utils/ssrfGuard.js):
 * resolve the hostname ourselves, reject loopback/private/link-local/
 * metadata targets, and pin the outbound connection to the exact validated
 * IP (never re-resolve at connect time — closes the DNS-rebinding TOCTOU
 * gap). On top of that, this adds what a fire-and-forget background
 * delivery needs that an interactive "test" button doesn't:
 *   - HMAC-SHA256 request signing with the per-user webhook_secret, so the
 *     receiving endpoint can verify the payload actually came from TFGen.
 *   - A bounded timeout per attempt.
 *   - Retry with backoff for transient failures (connection errors,
 *     timeouts, 5xx) — NOT for 4xx (the endpoint gave a definitive
 *     rejection) or SSRF validation failures (retrying can't fix those).
 */
const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { resolveSafeAddress, SsrfBlockedError } = require('./ssrfGuard');

const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS       = 3;
const BACKOFF_MS         = [500, 1500]; // delay before attempt 2 and attempt 3
// Delivery is fire-and-forget; we don't care about the response body, but we
// must still bound how much we'll read before giving up on the socket.
const MAX_RESPONSE_BYTES = 16 * 1024;

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make a single SSRF-safe outbound POST attempt. Resolves to
 * { ok: boolean, status?: number, retryable: boolean, error?: string }.
 */
async function attemptOnce(parsed, body, headers) {
  let safeTarget;
  try {
    safeTarget = await resolveSafeAddress(parsed.hostname);
  } catch (e) {
    // Not retryable — the target is structurally blocked (private/loopback/
    // metadata/unresolvable), not a transient network condition.
    return { ok: false, retryable: false, error: e instanceof SsrfBlockedError ? e.message : 'Could not validate webhook URL' };
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    host:   safeTarget.address,
    family: safeTarget.family,
    port:   parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:   parsed.pathname + parsed.search,
    method: 'POST',
    headers: { ...headers, Host: parsed.host },
    timeout: REQUEST_TIMEOUT_MS,
    ...(parsed.protocol === 'https:' ? { servername: parsed.hostname } : {}),
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    const reqOut = lib.request(options, (response) => {
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy();
      });
      const status = response.statusCode || 0;
      const done = () => finish({
        ok: status >= 200 && status < 300,
        status,
        // 5xx is the receiving service's own transient failure — worth
        // retrying. 4xx means the endpoint understood and rejected us
        // (bad signature, gone, etc.) — retrying won't change that.
        retryable: status >= 500,
      });
      response.on('end', done);
      response.on('close', done);
      response.on('error', () => finish({ ok: false, retryable: true, error: 'Response stream error' }));
    });

    reqOut.on('error', (err) => finish({ ok: false, retryable: true, error: err.message }));
    reqOut.on('timeout', () => { reqOut.destroy(); finish({ ok: false, retryable: true, error: 'Webhook request timed out' }); });
    reqOut.write(body);
    reqOut.end();
  });
}

/**
 * Deliver one webhook event to `url`, signing with `secret` if provided.
 * Retries transient failures with backoff. Never throws — always resolves,
 * so a bad/unreachable webhook can never affect the caller (the in-app
 * notification, which is the actual source of truth).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|null} [opts.secret]
 * @param {object} opts.event - JSON-serializable payload
 * @returns {Promise<{delivered: boolean, status?: number, attempts: number, error?: string}>}
 */
async function deliverWebhook({ url, secret, event }) {
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    return { delivered: false, attempts: 0, error: 'Invalid webhook URL' };
  }

  const body = JSON.stringify(event);
  const headers = {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-TFGen-Event':  event.type || 'notification',
  };
  if (secret) headers['X-TFGen-Signature'] = sign(secret, body);

  let lastResult = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastResult = await attemptOnce(parsed, body, headers);
    if (lastResult.ok || !lastResult.retryable) {
      return { delivered: lastResult.ok, status: lastResult.status, attempts: attempt, error: lastResult.error };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
  }
  return { delivered: false, status: lastResult?.status, attempts: MAX_ATTEMPTS, error: lastResult?.error };
}

module.exports = { deliverWebhook };
