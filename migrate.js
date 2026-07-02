#!/usr/bin/env node
'use strict';
/**
 * migrate.js — Simple sequential migration runner for TFGen
 *
 * Usage:
 *   node migrate.js              # apply all pending migrations
 *   node migrate.js --status     # show applied / pending migrations
 *   node migrate.js --dry-run    # print SQL that would be run, no DB changes
 *
 * Environment (read from process.env or backend/.env via dotenv):
 *   DATABASE_URL   postgresql://user:pass@host:5432/dbname
 *
 * Migration files must live in database/ and follow the naming convention:
 *   NNN_description.sql   e.g. 001_initial_schema.sql, 002_add_user_role.sql
 *
 * Each migration is wrapped in a transaction. If any statement fails the
 * transaction is rolled back and the script exits with code 1.
 *
 * A row is inserted into schema_migrations after each successful migration.
 * Re-running the script is safe — already-applied versions are skipped.
 */

const fs   = require('fs');
const path = require('path');

// ── FIX 1: Explicit dotenv load with clear error if missing ──────────────────
try {
  require('dotenv').config({ path: path.join(__dirname, 'backend', '.env') });
} catch (e) {
  // dotenv is optional — warn instead of silently failing
  if (e.code === 'MODULE_NOT_FOUND') {
    console.warn('[migrate] Warning: dotenv not installed. Falling back to process.env only.');
    console.warn('[migrate] Run: npm install dotenv  to enable .env file support.\n');
  } else {
    throw e;
  }
}

// ── FIX 2: pg import with clear error if missing ─────────────────────────────
let Client;
try {
  ({ Client } = require('pg'));
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    console.error('[migrate] ERROR: "pg" package is not installed.');
    console.error('[migrate] Run: npm install pg');
    process.exit(1);
  }
  throw e;
}

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('[migrate] ERROR: DATABASE_URL environment variable is not set.');
  console.error('[migrate] Either set it in your shell or add it to backend/.env');
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, 'database');

// ── FIX 3: Guard if database/ folder doesn't exist ───────────────────────────
if (!fs.existsSync(MIGRATIONS_DIR)) {
  console.error(`[migrate] ERROR: Migrations directory not found: ${MIGRATIONS_DIR}`);
  console.error('[migrate] Create a "database/" folder and add your .sql migration files.');
  process.exit(1);
}

// ── Discover migration files ──────────────────────────────────────────────────
// Accept files matching NNN_*.sql  (3+ leading digits, underscore, description)
const MIGRATION_RE = /^(\d{3,})_.+\.sql$/;

function discoverMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => MIGRATION_RE.test(f))
    .sort()   // lexicographic sort is correct for zero-padded numeric prefixes
    .map(filename => ({
      version:  filename.match(MIGRATION_RE)[1],
      filename,
      filepath: path.join(MIGRATIONS_DIR, filename),
    }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(255) PRIMARY KEY,
      filename    TEXT         NOT NULL,
      applied_at  TIMESTAMP    NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedVersions(client) {
  const { rows } = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return new Set(rows.map(r => r.version));
}

// ── Main ──────────────────────────────────────────────────────────────────────
// ── FIX 4: Wrap top-level async in .catch() to handle connection errors cleanly
(async () => {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const status  = args.includes('--status');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const forceIdx = args.findIndex(a => a === '--force-version');
  const forceVersion = forceIdx !== -1 ? args[forceIdx + 1] : null;

  // Print usage if --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log('\nUsage: node migrate.js [options]\n');
    console.log('  (no options)         Apply all pending migrations');
    console.log('  --status             Show applied / pending migrations');
    console.log('  --dry-run            Print SQL without executing');
    console.log('  --verbose, -v        Print each SQL statement before execution');
    console.log('  --force-version NNN  Mark a migration as applied without running it');
    console.log('  --help, -h           Show this message\n');
    process.exit(0);
  }

  const migrations = discoverMigrations();
  if (migrations.length === 0) {
    console.log('[migrate] No migration files found in database/');
    process.exit(0);
  }

  const client = new Client({ connectionString: DB_URL });

  // FIX 4: Catch connection errors with a clean message
  try {
    await client.connect();
  } catch (err) {
    console.error('[migrate] ERROR: Could not connect to the database.');
    console.error(`[migrate] Check your DATABASE_URL. Details: ${err.message}`);
    process.exit(1);
  }

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedVersions(client);

    if (status) {
      console.log('\nMigration status:\n');
      for (const m of migrations) {
        const state = applied.has(m.version) ? '✅ applied' : '⏳ pending';
        console.log(`  ${state}  ${m.filename}`);
      }
      console.log();
      return;
    }

    // Handle --force-version: mark a migration as applied without running SQL
    if (forceVersion) {
      const target = migrations.find(m => m.version === forceVersion);
      if (!target) {
        console.error(`[migrate] ERROR: No migration found with version "${forceVersion}"`);
        process.exit(1);
      }
      if (applied.has(forceVersion)) {
        console.log(`[migrate] Version ${forceVersion} is already in schema_migrations — skipping.`);
        return;
      }
      await client.query(
        'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
        [target.version, target.filename]
      );
      console.log(`[migrate] ✅ Force-marked ${target.filename} as applied (SQL not executed).`);
      return;
    }

    const pending = migrations.filter(m => !applied.has(m.version));
    if (pending.length === 0) {
      console.log('[migrate] All migrations already applied. Nothing to do.');
      return;
    }

    console.log(`[migrate] ${pending.length} migration(s) to apply.`);

    for (const m of pending) {
      const sql = fs.readFileSync(m.filepath, 'utf8');
      if (verbose) {
        console.log(`\n[migrate] → ${m.filename}`);
        console.log('[migrate]   SQL preview (first 200 chars):', sql.trim().slice(0, 200).replace(/\n/g, ' '));
      } else {
        console.log(`\n[migrate] → ${m.filename}`);
      }

      if (dryRun) {
        console.log('--- DRY RUN: SQL that would be executed ---');
        console.log(sql.trim());
        console.log('-------------------------------------------');
        continue;
      }

      // Each migration runs in its own transaction for atomicity
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
          [m.version, m.filename]
        );
        await client.query('COMMIT');
        console.log(`[migrate] ✅ ${m.filename} applied.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ❌ ${m.filename} FAILED — transaction rolled back.`);
        console.error(`[migrate]    ${err.message}`);
        process.exit(1);
      }
    }

    if (!dryRun) {
      console.log('\n[migrate] All migrations applied successfully.');
    }
  } finally {
    await client.end();
  }
})();
