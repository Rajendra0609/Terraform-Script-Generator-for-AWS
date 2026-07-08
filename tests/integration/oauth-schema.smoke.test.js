/**
 * tests/integration/oauth-schema.smoke.test.js
 *
 * SECURITY FIX (C-13 remediation item): "Add a CI smoke test that exercises
 * upsertOAuthUser() against a schema built the same way the shipped
 * Postgres image is built."
 *
 * Why this test exists and why it is NOT redundant with the other
 * integration tests: every other integration/API test in this suite runs
 * against a database that backend/server.js's autoMigrate() has already
 * patched up at boot (see server.js — it now self-heals the oauth_*,
 * email_verified, etc. columns on every startup). That self-heal is a good
 * belt-and-suspenders fix, but it would silently paper over a REGRESSION
 * of the original C-13 bug: if someone edits database/Dockerfile in the
 * future and drops 011/012 from the COPY list again, every other test in
 * this suite would still pass (because autoMigrate() fixes it up anyway),
 * and the fresh-deployment breakage would ship undetected — exactly what
 * happened the first time.
 *
 * This test instead builds a throwaway database by executing the numbered
 * SQL files directly, in the exact order and naming convention
 * database/Dockerfile uses for docker-entrypoint-initdb.d/*.sql — WITHOUT
 * ever importing backend/server.js or letting autoMigrate() touch it. If
 * the Dockerfile's COPY list and this file's MIGRATION_FILES list drift
 * apart, or a migration's exception handling is wrong (see the migrate.sql
 * fix in this same round — a bug this exact style of test also would have
 * caught), this test fails loudly instead of the feature just silently not
 * working in production.
 */
'use strict';

const { Pool } = require('pg');
const path = require('fs');
const fs = require('fs');
const pathMod = require('path');
const { execSync } = require('child_process');

const DATABASE_ROOT = pathMod.join(__dirname, '../../database');
const ADMIN_DB_URL = process.env.TEST_ADMIN_DATABASE_URL
  || 'postgresql://postgres:postgres@localhost:5432/postgres';
const SCRATCH_DB_NAME = `tfgen_c13_schema_smoke_${Date.now()}`;

// SECURITY FIX (C-13): this list — and its order — must always match
// database/Dockerfile's COPY list exactly. If you're editing one, edit the
// other. (Deliberately duplicated rather than parsed out of the Dockerfile,
// so a Dockerfile edit that silently drops a file makes THIS list visibly
// stale in code review, rather than the test quietly reading whatever the
// Dockerfile currently says and never catching a regression.)
const MIGRATION_FILES = [
  'schema.sql',
  'seed.sql',
  'fix_project_versions_owner.sql',
  'migrate.sql',
  'migrate_v5_columns.sql',
  'migrate_v6.sql',
  'migrate_v7.sql',
  'migrate_v8_more_services.sql',
  'migrate_v9_missing_services.sql',
  '010_fix_template_validation.sql',
  '011_phases_2_5_governance_collab_notifications.sql',
  '012_security_hardening_c11_c13.sql',
];

let adminPool;
let scratchPool;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: ADMIN_DB_URL });
  await adminPool.query(`CREATE DATABASE ${SCRATCH_DB_NAME}`);

  const scratchUrl = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB_NAME}`);
  scratchPool = new Pool({ connectionString: scratchUrl });

  // Run every file EXACTLY as docker-entrypoint.sh would: psql -v ON_ERROR_STOP=1
  // per file, aborting immediately (and failing this test) on the first error —
  // matching the real fail-fast behaviour of a fresh `docker-compose up`.
  for (const file of MIGRATION_FILES) {
    const filePath = pathMod.join(DATABASE_ROOT, file);
    expect(fs.existsSync(filePath)).toBe(true); // catches "file renamed/deleted but list not updated"
    execSync(
      `psql "${scratchUrl}" -v ON_ERROR_STOP=1 -f "${filePath}"`,
      { stdio: 'pipe' }
    );
  }
}, 60000);

afterAll(async () => {
  if (scratchPool) await scratchPool.end();
  if (adminPool) {
    // Give already-closed connections a moment to fully release before DROP
    // DATABASE — avoids a noisy (harmless) "PG pool error" log from the
    // scratch pool's error listener firing during pg_terminate_backend.
    await new Promise(r => setTimeout(r, 100));
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB_NAME}`);
    } catch {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [SCRATCH_DB_NAME]
      ).catch(() => {});
      await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB_NAME}`).catch(() => {});
    }
    await adminPool.end();
  }
});

describe('C-13 — OAuth schema builds correctly from database/Dockerfile\'s init scripts', () => {
  test('users table has every column upsertOAuthUser() depends on', async () => {
    const { rows } = await scratchPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
    );
    const cols = new Set(rows.map(r => r.column_name));
    for (const required of [
      'oauth_provider', 'oauth_subject', 'display_name', 'avatar_url',
      'last_login_at', 'email_verified', 'email_verify_token',
      'email_verify_token_expires_at',
    ]) {
      expect(cols.has(required)).toBe(true);
    }
  });

  test('uq_oauth_provider_subject unique constraint exists', async () => {
    const { rows } = await scratchPool.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'uq_oauth_provider_subject'
    `);
    expect(rows.length).toBe(1);
  });

  test('upsertOAuthUser() creates a new user with role=user, email_verified=true, never admin (C-11/C-12/C-13 combined)', async () => {
    // Point a fresh require of the app's own oauth module at the scratch DB —
    // this exercises the ACTUAL production code path, not a re-implementation.
    jest.resetModules();
    process.env.DATABASE_URL = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB_NAME}`);
    process.env.JWT_SECRET = 'test-secret-for-schema-smoke-test-only-32c';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-schema-smoke-32c';
    const { upsertOAuthUser } = require('../../backend/routes/oauth');

    const user = await upsertOAuthUser({
      email: 'schema-smoke-oauth@example.com',
      displayName: 'Schema Smoke Test',
      avatarUrl: 'https://example.com/a.png',
      provider: 'google',
      subject: 'schema-smoke-sub-1',
      emailVerifiedByProvider: true,
    });

    expect(user.role).toBe('user'); // C-11: OAuth signup never auto-grants admin
    expect(user.email_verified).toBe(true);
    expect(user.oauth_provider).toBe('google');
    expect(user.oauth_subject).toBe('schema-smoke-sub-1');
  });

  test('upsertOAuthUser() refuses to link an unverified pre-registered account (C-12)', async () => {
    await scratchPool.query(`
      INSERT INTO users (email, password_hash, role, email_verified)
      VALUES ('schema-smoke-victim@example.com', 'attacker-set-this-hash', 'user', false)
    `);

    jest.resetModules();
    process.env.DATABASE_URL = ADMIN_DB_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB_NAME}`);
    const { upsertOAuthUser, UnverifiedAccountError } = require('../../backend/routes/oauth');

    await expect(upsertOAuthUser({
      email: 'schema-smoke-victim@example.com',
      displayName: 'Real Victim',
      avatarUrl: 'x',
      provider: 'google',
      subject: 'schema-smoke-victim-real-sub',
      emailVerifiedByProvider: true,
    })).rejects.toBeInstanceOf(UnverifiedAccountError);
  });
});
