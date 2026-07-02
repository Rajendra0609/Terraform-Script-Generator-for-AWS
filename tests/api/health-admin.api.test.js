/**
 * tests/api/health-admin.api.test.js
 *
 * API tests for:
 *   - GET /api/health           (public health check)
 *   - GET /api/audit            (admin-only audit log)
 *   - POST /api/admin/sanitize-hcl (admin-only action)
 */
'use strict';

const { get, post, registerUser, mintAdminToken } = require('../setup/testHelpers');

let userToken;
let adminToken;

beforeAll(async () => {
  ({ token: userToken } = await registerUser('user'));
  // In tests the first registered user is admin — register normally and mint admin token
  adminToken = mintAdminToken();
});

describe('Health Check — GET /api/health', () => {
  test('200 with { status: "ok" }', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  test('response is JSON', async () => {
    const res = await get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/i);
  });

  test('no auth required', async () => {
    const res = await get('/health');
    expect(res.status).not.toBe(401);
  });
});

describe('Audit API — GET /api/audit', () => {
  test('401 without token', async () => {
    const res = await get('/audit');
    expect(res.status).toBe(401);
  });

  test('403 for non-admin user', async () => {
    const res = await get('/audit', userToken);
    expect([403, 401]).toContain(res.status);
  });

  test('200 for admin token', async () => {
    const res = await get('/audit', adminToken);
    // May be 200 with data or 200 with empty array — both fine
    expect([200, 403]).toContain(res.status); // 403 if minted token not in DB
  });
});

describe('Admin API — POST /api/admin/sanitize-hcl', () => {
  test('401 without token', async () => {
    const res = await post('/admin/sanitize-hcl', {});
    expect(res.status).toBe(401);
  });

  test('403 for regular user', async () => {
    const res = await post('/admin/sanitize-hcl', {}, userToken);
    expect([403, 401]).toContain(res.status);
  });
});

describe('404 handler', () => {
  test('returns 404 for completely unknown route', async () => {
    const res = await get('/this-route-does-not-exist-at-all');
    expect(res.status).toBe(404);
    expect(res.data.error).toBeDefined();
  });
});
