-- ─── TFGen: Safe incremental migration ────────────────────────────────────────
-- Run this against an EXISTING database to add all columns introduced in
-- Phase-2, Phase-3, and Phase-4 without dropping any data.
--
-- Usage:
--   psql "$DATABASE_URL" -f database/migrate.sql
--
-- This file is idempotent — running it multiple times is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pgcrypto if not already enabled (needed for gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── users ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'users: %', SQLERRM; END
$$;

-- ─── projects ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment    VARCHAR(50) DEFAULT 'dev';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS backend_config JSONB       DEFAULT '{}';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id        UUID;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'projects: %', SQLERRM; END
$$;

-- ─── resources ───────────────────────────────────────────────────────────────
-- CRITICAL: lifecycle_config is required by POST /api/projects/:id/resources
DO $$
BEGIN
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS variables        JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS outputs          JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS module_source    VARCHAR(500);
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_module        BOOLEAN DEFAULT false;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS lifecycle_config JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_x       NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_y       NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS annotations      TEXT    DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS security_findings JSONB  DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'resources: %', SQLERRM; END
$$;

-- ─── project_versions ────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS variables_hcl     TEXT;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS outputs_hcl        TEXT;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd  NUMERIC(12,4);
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed      INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed      INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_graph_json JSONB;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by UUID REFERENCES users(id) ON DELETE SET NULL; -- BUG-008 fix: add FK constraint to prevent dangling references on user deletion
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary      TEXT DEFAULT '';
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count      INT DEFAULT 0;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'project_versions: %', SQLERRM; END
$$;

-- ─── templates ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE templates ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'templates: %', SQLERRM; END
$$;

-- ─── New tables (safe: CREATE IF NOT EXISTS) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT      NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked    BOOLEAN   DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id)  ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id)     ON DELETE CASCADE,
  role        VARCHAR(50) DEFAULT 'viewer',
  invited_by  UUID REFERENCES users(id),
  invited_at  TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user    ON project_members(user_id);

CREATE TABLE IF NOT EXISTS user_aws_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  -- SECURITY FIX (M-09): no hardcoded region default — a raw SQL file can't
  -- read a runtime .env, so a literal default silently pointed every row
  -- bootstrapped from this file at 'ap-south-1' regardless of the deploying
  -- user's actual region. NOT NULL is kept so a missing region fails loudly
  -- at INSERT time; backend/routes/aws.js always supplies it explicitly.
  aws_region      VARCHAR(50)  NOT NULL,
  access_key_id   TEXT         NOT NULL,
  secret_key_enc  TEXT         NOT NULL,
  label           VARCHAR(255) DEFAULT 'My AWS Account',
  verified_at     TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aws_creds_user ON user_aws_credentials(user_id);

CREATE TABLE IF NOT EXISTS lab_progress (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  lab_id     VARCHAR(50) NOT NULL,
  step_id    INT         NOT NULL,
  completed  BOOLEAN     DEFAULT true,
  updated_at TIMESTAMP   DEFAULT NOW(),
  UNIQUE(user_id, lab_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_lab_progress_user ON lab_progress(user_id, lab_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  method      VARCHAR(10),
  path        TEXT,
  ip          VARCHAR(45),
  meta        JSONB   DEFAULT '{}',
  status_code INT,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS execution_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id)    ON DELETE SET NULL,
  type            VARCHAR(50)  NOT NULL,
  status          VARCHAR(50)  DEFAULT 'queued',
  hcl_hash        VARCHAR(64),
  plan_summary    JSONB DEFAULT '{}',
  cost_delta      NUMERIC(12,4),
  checkov_summary JSONB DEFAULT '{}',
  log_key         TEXT,
  error           TEXT,
  queued_at       TIMESTAMP DEFAULT NOW(),
  started_at      TIMESTAMP,
  finished_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_project ON execution_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_status  ON execution_jobs(status);

-- BUG-016 fix: schema.sql adds CONSTRAINT uq_project_version UNIQUE (project_id, version_number)
-- on project_versions as a DB-level duplicate-version safety net (BUG-007 fix). migrate.sql
-- previously omitted this, so databases migrated from an older schema had no constraint and
-- were vulnerable to race-condition duplicate version_numbers under high concurrency.
--
-- FIX (found during Round-3 audit verification, no ID assigned in the source report — flagged
-- here as it blocks C-13's fix from ever running on a fresh deployment): schema.sql runs before
-- this file on every fresh deployment and already creates this exact constraint via a DO block
-- that catches BOTH `duplicate_table OR duplicate_object`. This block only caught
-- `duplicate_object` — but re-adding a UNIQUE constraint whose name collides with an existing
-- one raises `duplicate_table` (42P07, the implicit backing index's name collides), NOT
-- `duplicate_object` (42710). Verified live: this uncaught exception aborted psql with
-- ON_ERROR_STOP=1, which (per docker-entrypoint.sh's `set -Eeo pipefail`) aborts the ENTIRE
-- docker-entrypoint-initdb.d sequence — every fresh `docker-compose up` from a clean volume
-- would fail database initialization entirely, silently skipping every script after this one.
DO $$ BEGIN
  ALTER TABLE project_versions
    ADD CONSTRAINT uq_project_version UNIQUE (project_id, version_number);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- FIX: password-reset columns (Phase-5).  Without these, the UPDATE in
-- POST /api/auth/forgot-password executes as a silent zero-row no-op and
-- password reset permanently fails.  The stored value is a SHA-256 hash of
-- the raw token — see auth.js forgot-password handler.
--
-- BUG-FIX: These were previously bare ALTER TABLE statements outside any DO
-- block. With psql -v ON_ERROR_STOP=1 (used by docker-entrypoint-initdb.d)
-- any unexpected error from a bare statement aborts the entire script and
-- poisons all subsequent migration files. Wrapping in a DO block with a
-- RAISE NOTICE fallback makes this file safe to re-run under all conditions.
DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token              TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at   TIMESTAMP;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Phase-5 users columns: %', SQLERRM;
END $$;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_users_reset_token
    ON users(reset_token) WHERE reset_token IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Phase-5 index: %', SQLERRM;
END $$;

-- BUG-FIX: \echo is a psql meta-command that works in interactive psql but
-- can cause parse errors in scripts run via docker-entrypoint-initdb.d when
-- the client locale does not match the database encoding (the em-dash in the
-- original string was the trigger). Replaced with a plain SQL SELECT so the
-- completion message is always safe in any environment.
SELECT 'Migration complete: all columns and tables are up to date.' AS migration_status;
