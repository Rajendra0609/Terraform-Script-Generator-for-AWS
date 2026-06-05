'use strict';
/**
 * Audit logging middleware.
 * Wraps mutating routes (POST/PUT/PATCH/DELETE) and writes a structured record
 * to the audit_logs table after the response is sent.
 *
 * Usage:
 *   router.post('/', authMiddleware, audit('project.create'), handler)
 *   router.delete('/:id', authMiddleware, audit('project.delete'), handler)
 *
 * IMPORTANT: audit() should only be applied to mutating routes (POST/PUT/PATCH/
 * DELETE). attachAuditResponseHook() must be added once per router via
 * router.use(attachAuditResponseHook) BEFORE the route definitions.  If
 * audit() is accidentally applied to a GET route the hook will skip it
 * because GET is not in the AUDITED_METHODS set below.
 */
const db = require('../db/connection');

// BUG-012 fix: only audit genuinely mutating HTTP methods.  This prevents
// spurious audit records when audit() is accidentally applied to a GET route,
// and makes the intent explicit in one place.
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function audit(action) {
  return (req, _res, next) => {
    // Attach action label so the response-finish hook can read it
    req._auditAction = action;
    next();
  };
}

/**
 * Response-finish hook — call this once per router to capture the result.
 * It patches res.json so we can capture the response body for the log entry.
 */
function attachAuditResponseHook(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // BUG-012 fix: skip read-only (GET/HEAD/OPTIONS) requests even if
    // _auditAction was accidentally set upstream.
    if (req._auditAction && req.user && AUDITED_METHODS.has(req.method)) {
      const userId     = req.user?.id || null;
      const action     = req._auditAction;
      const method     = req.method;
      const path       = req.originalUrl;
      const statusCode = res.statusCode;
      const ip         = req.ip || req.connection?.remoteAddress || 'unknown';

      // BUG-012 fix: promote success/failure to a top-level field so the audit
      // viewer can filter successful mutations from failed attempts without
      // parsing the nested meta.status value.
      const success = statusCode < 400;

      // Capture safe metadata only — never log full HCL or secrets
      const meta = {
        params:  req.params,
        query:   req.query,
        // Only include non-sensitive body keys
        body:    sanitizeBodyForAudit(req.body),
        success,                    // top-level for easy filtering
        status:  statusCode,        // kept for backwards compatibility
      };
      // Fire-and-forget — never block the response
      db.query(
        `INSERT INTO audit_logs (user_id, action, method, path, ip, meta, status_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [userId, action, method, path, ip, JSON.stringify(meta), statusCode]
      ).catch((err) => {
        // Log but never crash the request on audit failure
        console.error('[audit] Failed to write audit log:', err.message);
      });
    }
    return originalJson(body);
  };
  next();
}

function sanitizeBodyForAudit(body) {
  if (!body || typeof body !== 'object') return {};
  const REDACT_KEYS = ['password', 'password_hash', 'secret', 'token', 'hcl', 'hcl_output', 'full_hcl'];
  const safe = {};
  for (const [k, v] of Object.entries(body)) {
    if (REDACT_KEYS.some(r => k.toLowerCase().includes(r))) {
      safe[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 200) {
      safe[k] = v.slice(0, 200) + '…';
    } else if (typeof v === 'object') {
      safe[k] = '[object]';
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

module.exports = { audit, attachAuditResponseHook };
