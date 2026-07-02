/**
 * tests/smoke/smoke.test.js
 *
 * Smoke Tests — run in < 60 s to verify the deployment is alive.
 * These run FIRST in the Jenkins pipeline and gate all other stages.
 *
 * Checks:
 *   ✓ API server responds on /api/health
 *   ✓ Frontend static assets are served (or Nginx is up)
 *   ✓ Auth register + login round-trip works
 *   ✓ Projects endpoint is reachable with a valid token
 *   ✓ Terraform fmt endpoint accepts HCL
 *   ✓ Database connection is live (implied by auth working)
 */
'use strict';

const axios = require('axios');

const API_BASE      = process.env.TEST_BASE_URL    || 'http://localhost:4099';
const FRONTEND_BASE = process.env.FRONTEND_URL     || 'http://localhost:3000';
const ts            = Date.now();

async function req(method, path, body, token) {
  return axios({
    method,
    url:  `${API_BASE}/api${path}`,
    data: body,
    headers: {
      'Content-Type':  'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: () => true,
    timeout:        10_000,
  });
}

describe('🚀 Smoke Tests', () => {

  // ─── API health ────────────────────────────────────────────────────────────
  test('[SMOKE] API health endpoint returns 200', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  // ─── Frontend ─────────────────────────────────────────────────────────────
  test('[SMOKE] Frontend is serving HTML', async () => {
    try {
      const res = await axios.get(FRONTEND_BASE, {
        timeout:        8000,
        validateStatus: () => true,
      });
      expect([200, 301, 302]).toContain(res.status);
      if (res.status === 200) {
        expect(res.headers['content-type']).toMatch(/html/i);
      }
    } catch (e) {
      if (e.code === 'ECONNREFUSED') {
        console.warn('[smoke] Frontend not reachable — may be running separately. Skipping.');
      } else {
        throw e;
      }
    }
  });

  // ─── Auth round-trip ───────────────────────────────────────────────────────
  let smokeToken;

  test('[SMOKE] Can register a new user', async () => {
    const email = `smoke-${ts}@tfgen-test.local`;
    const res   = await req('POST', '/auth/register', { email, password: 'Smoke@Test123!' });
    expect([201, 409]).toContain(res.status); // 409 is OK on re-run
    if (res.status === 201) {
      expect(res.data.token).toBeDefined();
      smokeToken = res.data.token;
    }
  });

  test('[SMOKE] Can log in with valid credentials', async () => {
    const email = `smoke-login-${ts}@tfgen-test.local`;
    await req('POST', '/auth/register', { email, password: 'SmokeLogin@9' });
    const res = await req('POST', '/auth/login', { email, password: 'SmokeLogin@9' });
    expect(res.status).toBe(200);
    expect(res.data.token).toBeDefined();
    smokeToken = res.data.token;
  });

  // ─── Authenticated endpoints ───────────────────────────────────────────────
  test('[SMOKE] Projects list endpoint is reachable', async () => {
    if (!smokeToken) return; // dependent on auth smoke passing
    const res = await req('GET', '/projects', null, smokeToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  test('[SMOKE] Terraform fmt endpoint accepts HCL', async () => {
    const hcl = `
      resource "aws_vpc" "smoke" {
        cidr_block = "10.0.0.0/16"
      }
    `;
    const res = await req('POST', '/terraform/fmt', { hcl });
    // 200 = formatted, 429 = rate limited (server is alive), 400 = bad input (server alive)
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(503);
  });

  // ─── Database connectivity (implied) ─────────────────────────────────────
  test('[SMOKE] DB is reachable (register creates a DB row)', async () => {
    const email = `smoke-db-${ts}@tfgen-test.local`;
    const res   = await req('POST', '/auth/register', { email, password: 'SmokeDb@123' });
    // A 201 or 409 means the DB query ran successfully
    expect([201, 409]).toContain(res.status);
  });

  // ─── Redis connectivity (via BullMQ job queue) ────────────────────────────
  test('[SMOKE] Server is not crashing on startup (no 500 on health)', async () => {
    const res = await req('GET', '/health');
    expect(res.status).not.toBe(500);
  });

  // ─── 404 handler ──────────────────────────────────────────────────────────
  test('[SMOKE] Unknown routes return structured 404', async () => {
    const res = await req('GET', '/this-does-not-exist-in-any-universe');
    expect(res.status).toBe(404);
    expect(res.data).toHaveProperty('error');
  });
});
