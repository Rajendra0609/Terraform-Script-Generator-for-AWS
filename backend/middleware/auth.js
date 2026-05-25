'use strict';
const jwt = require('jsonwebtoken');

const JWT_SECRET         = process.env.JWT_SECRET          || 'tfgen-dev-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET  || 'tfgen-refresh-secret-change-in-production';

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

/** Require a valid JWT access token. Attaches req.user on success. */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, email: payload.email, role: payload.role || 'user' };
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
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, email: payload.email, role: payload.role || 'user' };
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
  signAccessToken,
  signRefreshToken,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  ROLE_LEVELS,
};
