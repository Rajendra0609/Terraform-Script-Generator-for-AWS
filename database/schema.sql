CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role       VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  aws_region  VARCHAR(50) DEFAULT 'ap-south-1',
  environment VARCHAR(50) DEFAULT 'dev',
  backend_config JSONB DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  service_type  VARCHAR(100),
  resource_name VARCHAR(255),
  config        JSONB,
  variables     JSONB DEFAULT '{}',
  outputs       JSONB DEFAULT '{}',
  is_module     BOOLEAN DEFAULT false,
  module_source VARCHAR(500),
  hcl_output    TEXT,
  position      INT DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  source      VARCHAR(500),
  version     VARCHAR(50),
  description TEXT,
  schema_def  JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type  VARCHAR(100) UNIQUE,
  cloud_provider VARCHAR(20) DEFAULT 'aws',
  label         VARCHAR(255),
  category      VARCHAR(100),
  icon          VARCHAR(50),
  is_module     BOOLEAN DEFAULT false,
  schema_def    JSONB,
  template_body TEXT,
  module_body   TEXT,
  data_sources  JSONB DEFAULT '[]',
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  version_number INT,
  full_hcl       TEXT,
  variables_hcl  TEXT,
  outputs_hcl    TEXT,
  resource_count INT DEFAULT 0,
  saved_at       TIMESTAMP DEFAULT NOW()
);
-- BUG-007 fix: prevent duplicate version numbers from concurrent saves
DO $$ BEGIN
  ALTER TABLE project_versions ADD CONSTRAINT uq_project_version UNIQUE (project_id, version_number);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS validation_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  is_valid   BOOLEAN,
  diagnostics JSONB,
  ran_at     TIMESTAMP DEFAULT NOW()
);

-- Upgrade existing schema when tables already exist
DO $$
BEGIN
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS environment VARCHAR(50) DEFAULT 'dev';
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS backend_config JSONB DEFAULT '{}';
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS user_id UUID;
  -- BUG-009 fix: ensure name can never be NULL regardless of migration path
  ALTER TABLE projects ALTER COLUMN name SET NOT NULL;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE projects: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '{}';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS outputs JSONB DEFAULT '{}';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS module_source VARCHAR(500);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE resources: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE templates: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS variables_hcl TEXT;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS outputs_hcl TEXT;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE project_versions: insufficient privilege or not owner';
END
$$;

-- ─── Phase-2 schema additions ────────────────────────────────────────────────

-- Refresh tokens for short-lived JWT rotation
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,           -- SHA-256 hash of token (never store raw)
  expires_at TIMESTAMP NOT NULL,
  revoked    BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Project team membership
CREATE TABLE IF NOT EXISTS project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(50) DEFAULT 'viewer',  -- viewer | editor | deployer
  invited_by  UUID REFERENCES users(id),
  invited_at  TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user    ON project_members(user_id);

-- Async execution jobs (plan / apply / validate)
CREATE TABLE IF NOT EXISTS execution_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  type         VARCHAR(50) NOT NULL,     -- fmt | validate | plan | apply
  status       VARCHAR(50) DEFAULT 'queued',  -- queued | running | succeeded | failed
  hcl_hash     VARCHAR(64),              -- SHA-256 of input HCL for dedup
  plan_summary JSONB DEFAULT '{}',       -- {add, change, destroy, resource_changes[]}
  cost_delta   NUMERIC(12,4),            -- USD/month delta from Infracost
  checkov_summary JSONB DEFAULT '{}',    -- {passed, failed, findings[]}
  log_key      TEXT,                     -- S3 or local path to full log archive
  error        TEXT,
  queued_at    TIMESTAMP DEFAULT NOW(),
  started_at   TIMESTAMP,
  finished_at  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_project ON execution_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_status  ON execution_jobs(status);

-- Audit log for all mutations (SOC-2 / ISO 27001 requirement)
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,   -- e.g. project.create, project.delete, apply.trigger
  method      VARCHAR(10),
  path        TEXT,
  ip          VARCHAR(45),
  meta        JSONB DEFAULT '{}',
  status_code INT,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

-- Policy rules (OPA/Rego source for policy-as-code)
CREATE TABLE IF NOT EXISTS policy_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  rego_source TEXT NOT NULL,            -- Rego policy body
  severity    VARCHAR(20) DEFAULT 'HIGH', -- CRITICAL | HIGH | MEDIUM | LOW
  enabled     BOOLEAN DEFAULT true,
  blocks_plan BOOLEAN DEFAULT false,    -- if true, a violation blocks plan execution
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- Change requests (PR-style reviews)
CREATE TABLE IF NOT EXISTS change_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  version_id  UUID REFERENCES project_versions(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  title       VARCHAR(255),
  description TEXT,
  status      VARCHAR(50) DEFAULT 'open',  -- open | approved | rejected | merged
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- Upgrade project_versions with cost + security snapshot columns
DO $$
BEGIN
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,4);
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS checkov_passed INT DEFAULT 0;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS checkov_failed INT DEFAULT 0;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS resource_graph_json JSONB;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS saved_by UUID REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS change_summary TEXT DEFAULT '';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE project_versions phase-2 columns';
END
$$;

-- Upgrade resources with canvas position + security findings
DO $$
BEGIN
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS position_x NUMERIC DEFAULT 0;
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS position_y NUMERIC DEFAULT 0;
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS security_findings JSONB DEFAULT '[]';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS lifecycle_config JSONB DEFAULT '{}';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS annotations TEXT;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE resources phase-2 columns';
END
$$;

-- AWS credentials stored per user (encrypted at rest via pgcrypto)
-- Access key + secret are encrypted with AES-256 using the app's ENCRYPT_KEY
CREATE TABLE IF NOT EXISTS user_aws_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  aws_region      VARCHAR(50)  NOT NULL DEFAULT 'ap-south-1',
  access_key_id   TEXT         NOT NULL,  -- stored as-is; encrypt in application layer
  secret_key_enc  TEXT         NOT NULL,  -- AES-256-GCM encrypted secret
  label           VARCHAR(255) DEFAULT 'My AWS Account',
  verified_at     TIMESTAMP,              -- set when a DescribeCallerIdentity succeeds
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aws_creds_user ON user_aws_credentials(user_id);

-- ─── Phase-3 schema additions ────────────────────────────────────────────────

-- Lab progress tracking for guided scenario labs
CREATE TABLE IF NOT EXISTS lab_progress (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  lab_id     VARCHAR(50) NOT NULL,
  step_id    INT NOT NULL,
  completed  BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, lab_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_lab_progress_user ON lab_progress(user_id, lab_id);

-- BUG-006 fix: indexes on the two most-queried tables that were missing
CREATE INDEX IF NOT EXISTS idx_resources_project        ON resources(project_id);
CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id);

-- NOTE: Phase-3 ALTER TABLE block removed — all columns were already added
-- in the Phase-2 DO blocks above with correct types and FK constraints.

-- ─── Phase-4: Idempotent safety net — always run these on startup ─────────────
-- These columns were added in Phase-2 blocks but may not exist if the DB was
-- initialised from an older version of this file. Adding with IF NOT EXISTS is safe.
DO $$
BEGIN
  -- resources: columns required by the /resources save endpoint
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS lifecycle_config  JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_x        NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_y        NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS annotations       TEXT    DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS security_findings JSONB   DEFAULT '[]';

  -- project_versions: columns required by the /versions save endpoint
  -- NOTE: resource_count is defined in the CREATE TABLE above; listed here
  --       only as a safety net for DBs migrated from very old schemas.
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,4);
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed     INT     DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed     INT     DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary     TEXT    DEFAULT '';
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by           UUID;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count     INT     DEFAULT 0;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Phase-4 migration warning: %', SQLERRM;
END
$$;
