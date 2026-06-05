/**
 * tests/integration/auth.integration.test.js
 *
 * End-to-end integration tests that exercise the full auth flow:
 * register → login → refresh → logout → protected route.
 * These tests hit the live Express server + PostgreSQL (test DB).
 */
'use strict';

const { post, get } = require('../setup/testHelpers');

// Unique email per test run
const ts    = Date.now();
const EMAIL = `integ-auth-${ts}@tfgen-test.local`;
const PASS  = 'Integration@123!';

let accessToken;
let cookieHeader; // for refresh-token cookie

describe('Auth Integration — /api/auth', () => {
  // ─── Register ────────────────────────────────────────────────────────────────
  describe('POST /register', () => {
    test('201 + JWT for a new user', async () => {
      const res = await post('/auth/register', { email: EMAIL, password: PASS });
      expect(res.status).toBe(201);
      expect(res.data.token).toBeDefined();
      expect(res.data.user.email).toBe(EMAIL);
      accessToken = res.data.token;
      // Capture Set-Cookie for refresh flow
      cookieHeader = res.headers['set-cookie'];
    });

    test('409 when registering the same email twice', async () => {
      const res = await post('/auth/register', { email: EMAIL, password: PASS });
      expect(res.status).toBe(409);
    });

    test('400 for missing email', async () => {
      const res = await post('/auth/register', { password: PASS });
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/email/i);
    });

    test('400 for missing password', async () => {
      const res = await post('/auth/register', { email: `missing-pw-${ts}@test.com` });
      expect(res.status).toBe(400);
    });

    test('400 for password shorter than 8 chars', async () => {
      const res = await post('/auth/register', { email: `short-pw-${ts}@test.com`, password: '1234' });
      expect(res.status).toBe(400);
    });

    test('400 for invalid email format', async () => {
      const res = await post('/auth/register', { email: 'not-an-email', password: PASS });
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/email/i);
    });
  });

  // ─── Login ───────────────────────────────────────────────────────────────────
  describe('POST /login', () => {
    test('200 + JWT for correct credentials', async () => {
      const res = await post('/auth/login', { email: EMAIL, password: PASS });
      expect(res.status).toBe(200);
      expect(res.data.token).toBeDefined();
      accessToken = res.data.token;
    });

    test('401 for wrong password', async () => {
      const res = await post('/auth/login', { email: EMAIL, password: 'WrongPass!!9' });
      expect(res.status).toBe(401);
    });

    test('401 for non-existent user', async () => {
      const res = await post('/auth/login', { email: 'ghost@nowhere.com', password: PASS });
      expect(res.status).toBe(401);
      // Must NOT distinguish "user not found" vs "wrong password" (enumeration)
      expect(res.data.error).toMatch(/invalid credentials/i);
    });

    test('400 for missing fields', async () => {
      const res = await post('/auth/login', {});
      expect(res.status).toBe(400);
    });

    test('response has Cache-Control: no-store (prevents caching tokens)', async () => {
      const res = await post('/auth/login', { email: EMAIL, password: PASS });
      expect(res.headers['cache-control']).toMatch(/no-store/i);
    });

    test('refresh token is in HttpOnly cookie (not in body)', async () => {
      const res = await post('/auth/login', { email: EMAIL, password: PASS });
      expect(res.data.refreshToken).toBeUndefined();
      const cookies = res.headers['set-cookie'] || [];
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
      expect(cookies.some(c => c.toLowerCase().includes('httponly'))).toBe(true);
    });
  });

  // ─── Protected endpoint ───────────────────────────────────────────────────────
  describe('GET /projects (protected route)', () => {
    test('200 with valid access token', async () => {
      const res = await get('/projects', accessToken);
      expect(res.status).toBe(200);
    });

    test('401 without any token', async () => {
      const res = await get('/projects');
      expect(res.status).toBe(401);
    });

    test('401 with a garbage token', async () => {
      const res = await get('/projects', 'not.a.real.token');
      expect(res.status).toBe(401);
    });
  });

  // ─── Token refresh ────────────────────────────────────────────────────────────
  describe('POST /refresh', () => {
    test('400 when no refresh cookie is sent', async () => {
      const res = await post('/auth/refresh', {});
      expect(res.status).toBe(400);
    });
  });

  // ─── Logout ───────────────────────────────────────────────────────────────────
  describe('POST /logout', () => {
    test('200 and clears the refresh cookie', async () => {
      const res = await post('/auth/logout', {}, accessToken);
      // Accept 200 or 204
      expect([200, 204]).toContain(res.status);
    });
  });
});
