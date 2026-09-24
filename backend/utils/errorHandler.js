'use strict';
/**
 * handleDbError — shared, safe error responder for route-level try/catch
 * blocks.
 *
 * SECURITY FIX (H-04): 62 locations across 9 route files previously did
 *
 *   catch (e) { res.status(500).json({ error: e.message }); }
 *
 * directly inside the handler, returning raw driver error text (frequently
 * including table/column names and query fragments — e.g. the exact
 * "column does not exist" error from C-13) unconditionally, in every
 * environment. This bypassed the NODE_ENV check the global error handler in
 * server.js already implements correctly (the "BUG-021 fix").
 *
 * This helper is the single place that decides what a caller is allowed to
 * see: the real error is always logged server-side (with a short correlation
 * id so it can be found in logs from the response the client received), and
 * the client gets a generic, NODE_ENV-aware message — the exact behaviour
 * the global handler already has, just reachable from inside a route's own
 * catch block instead of only when nothing catches at all.
 *
 * Usage:
 *   const { handleDbError } = require('../utils/errorHandler');
 *   ...
 *   } catch (e) {
 *     return handleDbError(e, res, 'Failed to save project');
 *   }
 */
const crypto = require('crypto');

function handleDbError(err, res, publicMessage, statusCode = 500) {
  const correlationId = crypto.randomBytes(6).toString('hex');
  // Full detail server-side only — this is the ONE place it's safe to log
  // e.message/e.stack, because it never reaches the HTTP response.
  console.error(`[error:${correlationId}]`, err && err.stack ? err.stack : err);

  const isProd = process.env.NODE_ENV === 'production';
  const body = {
    error: isProd
      ? (publicMessage || 'Something went wrong. Please try again.')
      : (err && err.message ? err.message : (publicMessage || 'Internal error')),
    correlationId,
  };
  return res.status(statusCode).json(body);
}

module.exports = { handleDbError };
