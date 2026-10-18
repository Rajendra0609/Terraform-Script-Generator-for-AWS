'use strict';
/**
 * Structured per-request access logging.
 *
 * OBSERVABILITY FIX: previously the ONLY per-request logging in this app was
 * (a) dev-only console output that's compiled out in production, and (b) the
 * audit-log middleware (middleware/audit.js), which only records
 * authenticated, mutating requests to the audit_logs table for compliance —
 * by design it says nothing about anonymous, read-only, or FAILED requests.
 * That gap is exactly why the OAuth "blocked redirect" bug (see
 * routes/oauth.js) was invisible in the logs: GET /api/auth/oauth/google is
 * anonymous and not mutating, so nothing was ever logged for it in
 * production, and there was no way to see "a 302 was issued, but the
 * follow-up /callback request never arrived" without this.
 *
 * This is intentionally a separate, always-on, production-safe access log —
 * every request, one line, regardless of auth state or method — with:
 *   - a correlation ID (honours an incoming X-Correlation-Id from a client
 *     or upstream proxy, otherwise mints one), echoed back on the response
 *     so a user/support ticket can quote it and an engineer can grep for the
 *     exact request instantly instead of correlating on approximate time;
 *   - the active OpenTelemetry trace/span ID when tracing is enabled, so a
 *     log line and a trace are two views of the same request;
 *   - method, route PATH ONLY (never the query string or body — several
 *     routes accept tokens, e.g. email verification/password reset links,
 *     as query params, and this must never end up in logs), status, and
 *     duration.
 * Deliberately does NOT log request/response bodies, headers, or query
 * strings — this is an access log, not a debug dump, and mustn't become a
 * secret-leakage surface itself.
 */

const crypto = require('crypto');
const { getTraceContext } = require('../observability/tracing');

function requestLogger(logger) {
  return function requestLoggerMiddleware(req, res, next) {
    const incoming = req.get('X-Correlation-Id') || req.get('X-Request-Id');
    req.correlationId = incoming || crypto.randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const { traceId, spanId } = getTraceContext();

      const entry = {
        correlationId: req.correlationId,
        method: req.method,
        // BUG fix (caught by actually running this against oauth.js, a
        // sub-router mounted at /api/auth/oauth): req.path is relative to
        // the innermost router a request was routed into by the time
        // 'finish' fires (e.g. "/google" instead of
        // "/api/auth/oauth/google") — req.originalUrl always holds the
        // full path Express received, but ALSO the query string, which
        // must never be logged (see the file-level comment on why: several
        // routes accept tokens as query params). Strip it here instead of
        // logging req.path directly.
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        userId: req.user?.id, // populated by middleware/auth.js when present; undefined for anonymous requests
      };
      if (traceId) { entry.traceId = traceId; entry.spanId = spanId; }

      const isNoisyHealthCheck = res.statusCode < 300 && (entry.path === '/api/health' || entry.path === '/metrics');
      if (isNoisyHealthCheck) {
        logger.debug('http_request', entry);
      } else if (res.statusCode >= 500) {
        logger.error('http_request', entry);
      } else if (res.statusCode >= 400) {
        logger.warn('http_request', entry);
      } else {
        logger.info('http_request', entry);
      }
    });

    next();
  };
}

module.exports = { requestLogger };
