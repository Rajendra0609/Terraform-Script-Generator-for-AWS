'use strict';
const jwt = require('jsonwebtoken');

// SECURITY FIX (critical — C-09, authentication bypass): this module used to
// fall back to hardcoded, publicly-known secret strings
// ('tfgen-dev-secret-change-in-production' / 'tfgen-refresh-secret-change-
// in-production') whenever JWT_SECRET / JWT_REFRESH_SECRET were unset. The
// shipped docker-compose.yml never set either var directly, so an operator
// who ran `docker-compose up` without independently creating a correct
// backend/.env got a backend that started up normally — no crash, no
// warning — using the literal default string. Anyone who knew (or guessed,
// since it's printed right here in the source) that string could forge a
// valid token for any user, including `role: "admin"`, and use it directly
// against every endpoint: a complete authentication bypass.
//
// Fix: apply the exact same fail-fast pattern already used correctly in
// backend/utils/awsCrypto.js for ENCRYPT_KEY — throw at require()-time
// (crashes startup with a clear [FATAL] message) if either secret is unset,
// still equal to its known-insecure former default, or too short/weak to
// resist brute force. The hardcoded default strings themselves are removed
// entirely so they can't be reused even accidentally.
const INSECURE_DEFAULTS = new Set([
  'tfgen-dev-secret-change-in-production',
  'tfgen-refresh-secret-change-in-production',
  'secret', 'changeme', 'change-me', 'password',
]);
const MIN_SECRET_LENGTH = 32;

function assertStrongSecret(name, value) {
  if (!value) {
    throw new Error(
      `[FATAL] ${name} environment variable is not set. Generate a strong random ` +
      `value (e.g. \`openssl rand -hex 32\`) and add it to backend/.env before starting. ` +
      `See backend/.env.example.`
    );
  }
  if (INSECURE_DEFAULTS.has(value)) {
    throw new Error(
      `[FATAL] ${name} is still set to a known insecure default value. ` +
      `Generate a strong random value (e.g. \`openssl rand -hex 32\`) and put it in backend/.env.`
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[FATAL] ${name} is only ${value.length} characters — must be at least ${MIN_SECRET_LENGTH} ` +
      `for adequate entropy. Generate one with \`openssl rand -hex 32\`.`
    );
  }
}

const JWT_SECRET         = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
assertStrongSecret('JWT_SECRET', JWT_SECRET);
assertStrongSecret('JWT_REFRESH_SECRET', JWT_REFRESH_SECRET);
if (JWT_SECRET === JWT_REFRESH_SECRET) {
  throw new Error('[FATAL] JWT_SECRET and JWT_REFRESH_SECRET must be different values.');
}

// Access token: 1 hour (short-lived for security)
// Refresh token: 7 days
const ACCESS_EXPIRY  = process.env.JWT_ACCESS_EXPIRY  || '1h';
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

/**
 * Role hierarchy (higher index = more privilege).
 * Used by requireRole() to enforce minimum role.
 */
const ROLE_LEVELS = { viewer: 0, user: 1, editor: 2, deployer: 3, admin: 4 };

function signAccessToken(payload) {
  return jwt.sign(
    { id: payload.id, email: payload.email, role: payload.role },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

function signRefreshToken(payload) {
  return jwt.sign(
    { id: payload.id },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRY }
  );
}

/**
 * Verify a raw access-token string and return its normalised payload, or
 * throw. Shared by authMiddleware/optionalAuth (Authorization header) AND
 * the WebSocket upgrade handler in server.js (token passed as ?token=...,
 * since browsers cannot set custom headers during a WS handshake). Keeping
 * this in one place means the WS auth path can never silently drift from
 * the HTTP auth path.
 */
function verifyAccessToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  return { id: payload.id, email: payload.email, role: payload.role || 'user' };
}

/** Require a valid JWT access token. Attaches req.user on success. */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (e) {
    const msg = e.name === 'TokenExpiredError' ? 'Token expired — please refresh' : 'Invalid or expired token';
    return res.status(401).json({ error: msg, code: e.name });
  }
}

/** Optional auth — attaches user if token present, but does not block unauthenticated requests. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
  } catch (_) { /* ignore */ }
  next();
}

/**
 * Require a minimum role.
 * Usage: router.delete('/:id', authMiddleware, requireRole('admin'), handler)
 *
 * Roles in ascending order: viewer < user < editor < deployer < admin
 */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const userLevel = ROLE_LEVELS[req.user.role] ?? -1;
    const requiredLevel = ROLE_LEVELS[minRole] ?? 99;
    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: `Insufficient permissions. Required: ${minRole}, your role: ${req.user.role}`,
      });
    }
    next();
  };
}

module.exports = {
  authMiddleware,
  optionalAuth,
  requireRole,
  verifyAccessToken,
  signAccessToken,
  signRefreshToken,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  ROLE_LEVELS,
};
