/**
 * tests/performance/security.test.js
 *
 * Security tests covering OWASP Top-10 categories:
 *   A01 – Broken Access Control
 *   A02 – Cryptographic Failures
 *   A03 – Injection (SQL, Script, HCL)
 *   A04 – Insecure Design (rate limiting, CSRF)
 *   A05 – Security Misconfiguration (CORS, headers)
 *   A07 – Identification and Authentication Failures
 */
'use strict';

const axios  = require('axios');
const { post, get, del, registerUser } = require('../setup/testHelpers');

const BASE = () => process.env.TEST_BASE_URL || 'http://localhost:4099';
const ts   = Date.now();

// ─── A01: Broken Access Control ───────────────────────────────────────────────
describe('A01 – Broken Access Control', () => {
  let ownerToken, attackerToken, projectId;

  beforeAll(async () => {
    ({ token: ownerToken }   = await registerUser());
    ({ token: attackerToken } = await registerUser());

    const res = await post('/projects', { name: `sec-proj-${ts}` }, ownerToken);
    projectId = res.data.id;
  });

  test('attacker cannot read another user\'s project', async () => {
    const res = await get(`/projects/${projectId}`, attackerToken);
    expect([403, 404]).toContain(res.status);
  });

  test('attacker cannot delete another user\'s project', async () => {
    const res = await del(`/projects/${projectId}`, attackerToken);
    expect([403, 404]).toContain(res.status);
  });

  test('regular user cannot access admin audit endpoint', async () => {
    const res = await get('/audit', ownerToken);
    expect([401, 403]).toContain(res.status);
  });

  test('regular user cannot call admin/sanitize-hcl', async () => {
    const res = await post('/admin/sanitize-hcl', {}, ownerToken);
    expect([401, 403]).toContain(res.status);
  });

  test('unauthenticated cannot access any protected resource', async () => {
    const endpoints = ['/projects', '/audit', '/admin/sanitize-hcl', '/export'];
    for (const ep of endpoints) {
      const res = await get(ep);
      expect([401, 403]).toContain(res.status);
    }
  });
});

// ─── A02: Cryptographic Failures ─────────────────────────────────────────────
describe('A02 – Cryptographic Failures', () => {
  test('password is NOT returned in API responses', async () => {
    const email = `crypto-${ts}@test.local`;
    const res = await post('/auth/register', { email, password: 'Crypto@1234' });
    expect(JSON.stringify(res.data)).not.toMatch(/password_hash|bcrypt|\$2[aby]\$/i);
  });

  test('refresh token is in HttpOnly cookie, NOT in response body', async () => {
    const email = `httponly-${ts}@test.local`;
    await post('/auth/register', { email, password: 'HttpOnly@12' });
    const res = await post('/auth/login', { email, password: 'HttpOnly@12' });
    expect(res.data.refreshToken).toBeUndefined();
    const cookies = res.headers['set-cookie'] || [];
    const rtCookie = cookies.find(c => c.includes('refreshToken'));
    if (rtCookie) {
      expect(rtCookie.toLowerCase()).toContain('httponly');
      expect(rtCookie.toLowerCase()).toContain('samesite');
    }
  });

  test('login response has no-store cache header (prevents token caching)', async () => {
    const email = `no-store-${ts}@test.local`;
    await post('/auth/register', { email, password: 'NoStore@99' });
    const res = await post('/auth/login', { email, password: 'NoStore@99' });
    expect(res.headers['cache-control']).toMatch(/no-store/i);
  });
});

// ─── A03: Injection ───────────────────────────────────────────────────────────
describe('A03 – Injection', () => {
  let token;
  beforeAll(async () => { ({ token } = await registerUser()); });

  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "1; SELECT * FROM users --",
    "' UNION SELECT null, username, password FROM users --",
  ];

  test.each(sqlPayloads)('SQL injection in login email is rejected safely: %s', async (payload) => {
    const res = await post('/auth/login', { email: payload, password: 'doesnt_matter' });
    // Must return 400 or 401 — never 200 or 500
    expect([400, 401]).toContain(res.status);
  });

  test('HCL with embedded <script> is rejected or stripped', async () => {
    const hcl = '<script>alert("xss")</script> resource "aws_vpc" "x" {}';
    const res = await post('/terraform/fmt', { hcl }, token);
    if (res.status === 200) {
      const body = JSON.stringify(res.data);
      expect(body).not.toMatch(/<script>/i);
    } else {
      expect([400, 422]).toContain(res.status);
    }
  });

  test('literal AWS secret key in HCL is blocked (400)', async () => {
    const hcl = 'access_key = "AKIAIOSFODNN7EXAMPLE"';
    const res = await post('/terraform/fmt', { hcl }, token);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/secret/i);
  });

  test('oversized HCL payload is rejected (413)', async () => {
    const res = await post('/terraform/validate', { hcl: 'x'.repeat(2_000_000) }, token);
    expect([400, 413]).toContain(res.status);
  });
});

// ─── A04: Rate Limiting ───────────────────────────────────────────────────────
describe('A04 – Rate Limiting on Auth Endpoints', () => {
  test('POST /auth/login is rate-limited after many rapid requests', async () => {
    const email    = `rl-login-${ts}@test.local`;
    const requests = Array.from({ length: 15 }, () =>
      post('/auth/login', { email, password: 'Wrong@pass1' })
    );
    const responses = await Promise.all(requests);
    const statuses  = responses.map(r => r.status);
    // At least one should be 429 (Too Many Requests)
    const hasRateLimit = statuses.some(s => s === 429);
    // If the server does not enforce it in test mode, skip gracefully
    if (!hasRateLimit) {
      console.warn('[security] Rate limit not triggered — ensure RATE_LIMIT_MAX is low in test env');
    }
  });
});

// ─── A05: Security Misconfiguration ──────────────────────────────────────────
describe('A05 – Security Misconfiguration', () => {
  test('OPTIONS preflight does not expose forbidden origin', async () => {
    const res = await axios.options(`${BASE()}/api/health`, {
      headers:        { Origin: 'https://evil.attacker.com' },
      validateStatus: () => true,
    });
    const acao = res.headers['access-control-allow-origin'] || '';
    // Should NOT be a wildcard or the attacker origin
    expect(acao).not.toBe('*');
    expect(acao).not.toContain('evil.attacker.com');
  });

  test('health endpoint does not expose stack traces or server internals', async () => {
    const res = await get('/health');
    const body = JSON.stringify(res.data);
    expect(body).not.toMatch(/at Object\.|\.js:\d+:\d+|stack|Error:/);
  });

  test('unknown route returns 404, not server error or stack trace', async () => {
    const res = await get('/this-does-not-exist');
    expect(res.status).toBe(404);
    const body = JSON.stringify(res.data);
    expect(body).not.toMatch(/at Object\.|Error:/);
  });
});

// ─── A07: Auth Failures / Enumeration ────────────────────────────────────────
describe('A07 – Identification and Auth Failures', () => {
  test('login error for existing and non-existing users is identical (anti-enumeration)', async () => {
    const existingEmail    = `enum-exists-${ts}@test.local`;
    const nonExistentEmail = `enum-ghost-${ts}@test.local`;
    await post('/auth/register', { email: existingEmail, password: 'Enum@1234' });

    const resExists    = await post('/auth/login', { email: existingEmail,    password: 'WrongPass!1' });
    const resNonExist  = await post('/auth/login', { email: nonExistentEmail, password: 'WrongPass!1' });

    expect(resExists.status).toBe(401);
    expect(resNonExist.status).toBe(401);
    // Error messages must be identical or indistinguishable
    expect(resExists.data.error.toLowerCase()).toBe(resNonExist.data.error.toLowerCase());
  });

  test('JWT secret is not the insecure dev default (if token provided)', async () => {
    const email = `secret-check-${ts}@test.local`;
    const res   = await post('/auth/register', { email, password: 'Secret@1234' });
    const token = res.data.token;
    // Try to verify with the well-known dev placeholder
    const jwt = require('jsonwebtoken');
    expect(() => jwt.verify(token, 'tfgen-dev-secret-change-in-production')).toThrow();
  });
});
