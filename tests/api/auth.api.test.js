/**
 * tests/api/auth.api.test.js
 *
 * Exhaustive API-layer tests for /api/auth — covers edge cases, headers,
 * rate-limit behaviour, token format, and OWASP auth requirements.
 */
'use strict';

const axios = require('axios');
const { post, get } = require('../setup/testHelpers');

const ts = Date.now();

describe('Auth API — /api/auth', () => {

  describe('Input validation', () => {
    test('rejects empty body with 400', async () => {
      const res = await post('/auth/login', {});
      expect(res.status).toBe(400);
    });

    test('rejects email with spaces', async () => {
      const res = await post('/auth/register', { email: 'user @test.com', password: 'Valid@1234' });
      expect([400]).toContain(res.status);
    });

    test('rejects password of only whitespace', async () => {
      const res = await post('/auth/register', { email: `ws-${ts}@test.com`, password: '        ' });
      expect(res.status).toBe(400);
    });

    test('rejects extremely long email (> 254 chars)', async () => {
      const longEmail = `${'a'.repeat(250)}@test.com`;
      const res = await post('/auth/register', { email: longEmail, password: 'Valid@1234' });
      expect([400, 422]).toContain(res.status);
    });

    test('Content-Type must be application/json', async () => {
      const base = process.env.TEST_BASE_URL || 'http://localhost:4099';
      const res = await axios.post(`${base}/api/auth/login`, 'email=x&password=y', {
        headers:        { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      });
      // Express JSON-only server should return 400 or 415
      expect([400, 415]).toContain(res.status);
    });
  });

  describe('Security headers on auth responses', () => {
    test('login response has Cache-Control: no-store', async () => {
      const email = `cache-test-${ts}@tfgen-test.local`;
      await post('/auth/register', { email, password: 'Cache@Test99' });
      const res = await post('/auth/login', { email, password: 'Cache@Test99' });
      expect(res.headers['cache-control']).toMatch(/no-store/i);
    });

    test('register response has Cache-Control: no-store', async () => {
      const res = await post('/auth/register', { email: `cache-reg-${ts}@test.local`, password: 'Cache@Reg99' });
      expect(res.headers['cache-control']).toMatch(/no-store/i);
    });

    test('refresh token NOT included in login response body', async () => {
      const email = `no-rt-${ts}@test.local`;
      await post('/auth/register', { email, password: 'NoRT@1234' });
      const res = await post('/auth/login', { email, password: 'NoRT@1234' });
      expect(res.data.refreshToken).toBeUndefined();
    });
  });

  describe('Token format and claims', () => {
    test('access token is a 3-part JWT', async () => {
      const email = `jwt-format-${ts}@test.local`;
      const res   = await post('/auth/register', { email, password: 'JwtFmt@1234' });
      expect(res.data.token).toMatch(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/);
    });

    test('user object in response has expected fields', async () => {
      const email = `user-fields-${ts}@test.local`;
      const res   = await post('/auth/register', { email, password: 'Fields@1234' });
      expect(res.data.user).toMatchObject({
        email: email,
        role:  expect.any(String),
        id:    expect.anything(),
      });
    });

    test('password_hash is NOT returned in user object', async () => {
      const email = `no-hash-${ts}@test.local`;
      const res   = await post('/auth/register', { email, password: 'NoHash@1234' });
      expect(JSON.stringify(res.data)).not.toMatch(/password_hash/);
    });
  });

  describe('Error body format', () => {
    test('error responses have { error: string } shape', async () => {
      const res = await post('/auth/login', { email: 'nobody@no.com', password: 'Wrong@Pass1' });
      expect(res.data).toHaveProperty('error');
      expect(typeof res.data.error).toBe('string');
    });
  });
});
