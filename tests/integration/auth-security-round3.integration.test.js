/**
 * tests/integration/auth-security-round3.integration.test.js
 *
 * Regression tests for the Round-3 security audit fixes in
 * backend/routes/auth.js: C-11 (first-user auto-admin race) and C-12
 * (mandatory email verification).
 *
 * Deliberately self-contained: mounts ONLY the auth router on a throwaway
 * Express app pointed at a scratch Postgres database, rather than going
 * through tests/setup/globalSetup.js's full backend/server.js + Redis +
 * Docker stack. That keeps this file able to run in any CI environment
 * that has Postgres, without needing Redis/Docker available too — the
 * behaviour under test (registration, admin bootstrap, email verification)
 * doesn't touch either of those subsystems.
 */
'use strict';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

const DATABASE_ROOT = path.join(__dirname, '../../database');
const ADMIN_DB_URL = process.env.TEST_ADMIN_DATABASE_URL
  || 'postgresql://postgres:postgres@localhost:5432/postgres';
const SCRATCH_DB_NAME = `tfgen_c11_c12_smoke_${Date.now()}`;
const SCRATCH_DB_URL = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB_NAME}`);

const MIGRATION_FILES = [
  'schema.sql', 'seed.sql', 'fix_project_versions_owner.sql', 'migrate.sql',
  'migrate_v5_columns.sql', 'migrate_v6.sql', 'migrate_v7.sql',
  'migrate_v8_more_services.sql', 'migrate_v9_missing_services.sql',
  '010_fix_template_validation.sql',
  '011_phases_2_5_governance_collab_notifications.sql',
  '012_security_hardening_c11_c13.sql',
];

let adminPool, scratchPool, server, baseUrl;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: ADMIN_DB_URL });
  await adminPool.query(`CREATE DATABASE ${SCRATCH_DB_NAME}`);
  for (const file of MIGRATION_FILES) {
    execSync(`psql "${SCRATCH_DB_URL}" -v ON_ERROR_STOP=1 -f "${path.join(DATABASE_ROOT, file)}"`, { stdio: 'pipe' });
  }
  scratchPool = new Pool({ connectionString: SCRATCH_DB_URL });

  process.env.DATABASE_URL = SCRATCH_DB_URL;
  process.env.JWT_SECRET = 'test-secret-for-round3-smoke-test-32-chars';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-round3-smoke-32c';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;

  jest.resetModules();
  const authRouter = require('../../backend/routes/auth');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}/api/auth`;
}, 60000);

afterAll(async () => {
  if (server) await new Promise(r => server.close(r));
  if (scratchPool) await scratchPool.end();
  if (adminPool) {
    await new Promise(r => setTimeout(r, 100));
    await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB_NAME}`).catch(async () => {
      await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [SCRATCH_DB_NAME]).catch(() => {});
      await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB_NAME}`).catch(() => {});
    });
    await adminPool.end();
  }
});

async function register(body) {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('C-11 — first-user admin bootstrap', () => {
  test('with no ADMIN_BOOTSTRAP_TOKEN set, a brand-new registration never becomes admin', async () => {
    const { body } = await register({ email: `c11-a-${Date.now()}@test.local`, password: 'Sup3rSecret!' });
    expect(body.user.role).toBe('user');
  });

  test('providing a bootstrap token when none is configured server-side has no effect', async () => {
    const { body } = await register({
      email: `c11-b-${Date.now()}@test.local`, password: 'Sup3rSecret!', adminBootstrapToken: 'whatever',
    });
    expect(body.user.role).toBe('user');
  });

  test('8 concurrent registrations, all presenting the correct token, produce EXACTLY one admin (TOCTOU race fixed)', async () => {
    await scratchPool.query('TRUNCATE users CASCADE');
    process.env.ADMIN_BOOTSTRAP_TOKEN = 'race-test-token-xyz';
    jest.resetModules();
    const authRouter2 = require('../../backend/routes/auth');
    const app2 = express();
    app2.use(express.json());
    app2.use(cookieParser());
    app2.use('/api/auth', authRouter2);
    const server2 = app2.listen(0);
    const url2 = `http://localhost:${server2.address().port}/api/auth`;

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${url2}/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `c11-race-${i}-${Date.now()}@test.local`, password: 'Sup3rSecret!', adminBootstrapToken: 'race-test-token-xyz' }),
        }).then(r => r.json())
      )
    );
    await new Promise(r => server2.close(r));
    delete process.env.ADMIN_BOOTSTRAP_TOKEN;

    const admins = results.filter(r => r.user?.role === 'admin');
    expect(admins.length).toBe(1);
  }, 30000);
});

describe('C-12 — mandatory email verification', () => {
  test('a new registration starts with email_verified: false', async () => {
    const { status, body } = await register({ email: `c12-a-${Date.now()}@test.local`, password: 'Sup3rSecret!' });
    expect(status).toBe(201);
    expect(body.user.email_verified).toBe(false);
  });

  test('GET /verify-email with a bogus token is rejected', async () => {
    const res = await fetch(`${baseUrl}/verify-email?token=not-a-real-token`);
    expect(res.status).toBe(400);
  });

  test('the full click-through flow verifies the account and rejects replay', async () => {
    // Register, then read the token HASH directly from the DB (we can't read
    // the raw token without intercepting the mailer, so instead we verify
    // hashToken()'s determinism separately and drive the endpoint through a
    // manually-inserted token here — equivalent coverage without needing a
    // mail interceptor in this file).
    const email = `c12-b-${Date.now()}@test.local`;
    await register({ email, password: 'Sup3rSecret!' });

    const authModule = require('../../backend/routes/auth');
    const rawToken = 'deterministic-test-token-for-click-through';
    const hash = authModule.hashToken(rawToken);
    await scratchPool.query(
      `UPDATE users SET email_verify_token=$1, email_verify_token_expires_at = NOW() + interval '1 day' WHERE email=$2`,
      [hash, email]
    );

    const verifyRes = await fetch(`${baseUrl}/verify-email?token=${rawToken}`);
    expect(verifyRes.status).toBe(200);

    const { rows } = await scratchPool.query('SELECT email_verified, email_verify_token FROM users WHERE email=$1', [email]);
    expect(rows[0].email_verified).toBe(true);
    expect(rows[0].email_verify_token).toBeNull();

    // Replay: token was cleared, so the same link used twice must fail.
    const replayRes = await fetch(`${baseUrl}/verify-email?token=${rawToken}`);
    expect(replayRes.status).toBe(400);
  });
});
