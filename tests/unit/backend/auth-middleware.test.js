/**
 * tests/unit/backend/auth-middleware.test.js
 *
 * Tests for backend/middleware/auth.js:
 *   - signAccessToken / signRefreshToken
 *   - authMiddleware (token verification)
 *   - requireRole (RBAC enforcement)
 *   - optionalAuth (passthrough)
 */
'use strict';

const path = require('path');
const jwt  = require('jsonwebtoken');

// Set required env vars before requiring the module
process.env.JWT_SECRET         = 'unit-test-jwt-secret';
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret';
process.env.ENCRYPT_KEY        = 'test-encrypt-key-exactly-32-char';

const {
  signAccessToken,
  signRefreshToken,
  authMiddleware,
  optionalAuth,
  requireRole,
  ROLE_LEVELS,
} = require(path.join(__dirname, '../../../backend/middleware/auth'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(token) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    user:    undefined,
  };
}

// ─── signAccessToken ──────────────────────────────────────────────────────────
describe('signAccessToken()', () => {
  const payload = { id: 'u1', email: 'user@test.com', role: 'user' };

  test('returns a string JWT', () => {
    const token = signAccessToken(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);   // header.payload.signature
  });

  test('JWT contains id, email, role claims', () => {
    const token   = signAccessToken(payload);
    const decoded = jwt.decode(token);
    expect(decoded.id).toBe(payload.id);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.role).toBe(payload.role);
  });

  test('JWT expires in the future', () => {
    const token   = signAccessToken(payload);
    const decoded = jwt.decode(token);
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('is verifiable with JWT_SECRET', () => {
    const token = signAccessToken(payload);
    expect(() => jwt.verify(token, process.env.JWT_SECRET)).not.toThrow();
  });
});

// ─── signRefreshToken ─────────────────────────────────────────────────────────
describe('signRefreshToken()', () => {
  test('contains id but NOT email or role (minimal payload)', () => {
    const token   = signRefreshToken({ id: 'u1', email: 'x@y.com', role: 'admin' });
    const decoded = jwt.decode(token);
    expect(decoded.id).toBe('u1');
    expect(decoded.email).toBeUndefined();
    expect(decoded.role).toBeUndefined();
  });

  test('signed with JWT_REFRESH_SECRET (not JWT_SECRET)', () => {
    const token = signRefreshToken({ id: 'u1' });
    expect(() => jwt.verify(token, process.env.JWT_REFRESH_SECRET)).not.toThrow();
    expect(() => jwt.verify(token, process.env.JWT_SECRET)).toThrow();
  });
});

// ─── authMiddleware ───────────────────────────────────────────────────────────
describe('authMiddleware()', () => {
  test('calls next() and sets req.user for a valid token', () => {
    const payload = { id: 'u1', email: 'u@test.com', role: 'editor' };
    const token   = signAccessToken(payload);
    const req     = mockReq(token);
    const res     = mockRes();
    const next    = jest.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe('u1');
    expect(req.user.role).toBe('editor');
  });

  test('returns 401 when Authorization header is missing', () => {
    const req  = mockReq(null);
    const res  = mockRes();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 for a tampered / invalid token', () => {
    const req  = mockReq('totally.invalid.token');
    const res  = mockRes();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 for an expired token', () => {
    const token = jwt.sign({ id: 'u1', email: 'e@e.com', role: 'user' },
                           process.env.JWT_SECRET, { expiresIn: '-1s' });
    const req   = mockReq(token);
    const res   = mockRes();
    const next  = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toMatch(/expired/i);
  });
});

// ─── requireRole ──────────────────────────────────────────────────────────────
describe('requireRole()', () => {
  function buildReq(role) {
    return { user: { id: 'u1', email: 'x@x.com', role } };
  }

  test.each([
    ['viewer',   'user',     403],
    ['user',     'editor',   403],
    ['editor',   'deployer', 403],
    ['deployer', 'admin',    403],
  ])('%s trying to access %s-only route → 403', (userRole, required, expectedStatus) => {
    const middleware = requireRole(required);
    const req  = buildReq(userRole);
    const res  = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(expectedStatus);
    expect(next).not.toHaveBeenCalled();
  });

  test.each([
    ['admin',    'viewer'],
    ['admin',    'admin'],
    ['deployer', 'deployer'],
    ['editor',   'user'],
    ['user',     'viewer'],
  ])('%s role satisfies minimum %s requirement', (userRole, required) => {
    const middleware = requireRole(required);
    const req  = buildReq(userRole);
    const res  = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when req.user is missing', () => {
    const middleware = requireRole('user');
    const req  = {};
    const res  = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ─── optionalAuth ─────────────────────────────────────────────────────────────
describe('optionalAuth()', () => {
  test('sets req.user for a valid token and calls next()', () => {
    const token = signAccessToken({ id: 'u2', email: 'opt@test.com', role: 'user' });
    const req   = mockReq(token);
    const next  = jest.fn();

    optionalAuth(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe('u2');
  });

  test('does NOT block and calls next() even with no token', () => {
    const req  = mockReq(null);
    const next = jest.fn();

    optionalAuth(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  test('does NOT block for an invalid token (just skips user)', () => {
    const req  = mockReq('bad.token.here');
    const next = jest.fn();

    optionalAuth(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});

// ─── ROLE_LEVELS hierarchy ────────────────────────────────────────────────────
describe('ROLE_LEVELS hierarchy', () => {
  test('viewer < user < editor < deployer < admin', () => {
    expect(ROLE_LEVELS.viewer).toBeLessThan(ROLE_LEVELS.user);
    expect(ROLE_LEVELS.user).toBeLessThan(ROLE_LEVELS.editor);
    expect(ROLE_LEVELS.editor).toBeLessThan(ROLE_LEVELS.deployer);
    expect(ROLE_LEVELS.deployer).toBeLessThan(ROLE_LEVELS.admin);
  });
});
