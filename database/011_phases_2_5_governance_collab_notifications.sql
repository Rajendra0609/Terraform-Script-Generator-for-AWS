-- =============================================================================
-- 011_phases_2_5_governance_collab_notifications.sql
-- TFGen Phase 2-5 Schema Additions
-- =============================================================================
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- Covers:
--   Phase 2: policy_rules, change_requests, change_request_comments
--   Phase 3: user_preferences (notification settings)
--   Phase 4: notifications table
--   Phase 5: schema_migrations self-registration, OIDC provider columns
-- =============================================================================

-- ─── Phase 2: Governance-as-Code ──────────────────────────────────────────────

-- Policy rules: OPA/Rego policies evaluated on every plan
CREATE TABLE IF NOT EXISTS policy_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255)  NOT NULL,
  description TEXT,
  rego_source TEXT          NOT NULL,
  severity    VARCHAR(20)   NOT NULL DEFAULT 'HIGH'
                            CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  enabled     BOOLEAN       NOT NULL DEFAULT true,
  blocks_plan BOOLEAN       NOT NULL DEFAULT false,  -- if true, violation stops plan
  created_by  UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_rules_enabled
  ON policy_rules(enabled, severity DESC)
  WHERE enabled = true;

-- Change requests: PR-style review workflow gating terraform apply
CREATE TABLE IF NOT EXISTS change_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID          NOT NULL REFERENCES projects(id)         ON DELETE CASCADE,
  version_id    UUID          NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  author_id     UUID          REFERENCES users(id) ON DELETE SET NULL,
  title         VARCHAR(255),
  description   TEXT,
  status        VARCHAR(50)   NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','approved','rejected','merged')),
  approved_by   UUID          REFERENCES users(id) ON DELETE SET NULL,
  approved_at   TIMESTAMP,
  rejected_by   UUID          REFERENCES users(id) ON DELETE SET NULL,
  rejected_at   TIMESTAMP,
  reject_reason TEXT,
  merged_at     TIMESTAMP,
  created_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cr_project  ON change_requests(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cr_author   ON change_requests(author_id);
CREATE INDEX IF NOT EXISTS idx_cr_status   ON change_requests(status);
CREATE INDEX IF NOT EXISTS idx_cr_version  ON change_requests(version_id);

-- Comments on change requests (discussion thread)
CREATE TABLE IF NOT EXISTS change_request_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id UUID          NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  author_id         UUID          REFERENCES users(id) ON DELETE SET NULL,
  body              TEXT          NOT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cr_comments
  ON change_request_comments(change_request_id, created_at ASC);

-- ─── Phase 4: In-app notifications ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(100)  NOT NULL,  -- e.g. change_request.approved, plan.failed
  title      VARCHAR(255)  NOT NULL,
  body       TEXT,
  link       TEXT,                    -- relative URL to navigate to on click
  actor_id   UUID          REFERENCES users(id) ON DELETE SET NULL,
  read_at    TIMESTAMP,               -- NULL = unread
  created_at TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- Partial index on unread notifications (the primary access pattern)
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Full index for "all notifications" queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_all
  ON notifications(user_id, created_at DESC);

-- ─── Phase 3: User preferences (notification settings) ────────────────────────

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id              UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Notification channel toggles
  notify_email         BOOLEAN NOT NULL DEFAULT true,
  notify_inapp         BOOLEAN NOT NULL DEFAULT true,
  -- Webhook integration
  webhook_url          TEXT,
  webhook_secret       TEXT,           -- HMAC secret for signing payloads
  -- Per-event toggles
  notify_plan_done     BOOLEAN NOT NULL DEFAULT true,
  notify_apply_done    BOOLEAN NOT NULL DEFAULT true,
  notify_cr_review     BOOLEAN NOT NULL DEFAULT true,   -- CR submitted for review
  notify_policy_fail   BOOLEAN NOT NULL DEFAULT true,   -- governance policy blocked plan
  -- OAuth preference
  oauth_provider       VARCHAR(50),                     -- 'google' | 'github' | null
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ─── Phase 3: OAuth / SSO scaffold ────────────────────────────────────────────
-- Adds optional OIDC columns to users table (safe to apply on existing DBs)

DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider   VARCHAR(50);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_subject    TEXT;          -- provider's user ID
  ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name     VARCHAR(255);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url       TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at    TIMESTAMP;
  -- suspended_at: set to a timestamp to soft-ban; cleared to unsuspend
  ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping Phase-3 users columns: insufficient privilege';
END
$$;

-- Unique constraint: one user per oauth_provider + oauth_subject combination
DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT uq_oauth_provider_subject
    UNIQUE (oauth_provider, oauth_subject);
EXCEPTION WHEN duplicate_table OR duplicate_object OR others THEN
  NULL;  -- already exists or not applicable
END
$$;

CREATE INDEX IF NOT EXISTS idx_users_oauth
  ON users(oauth_provider, oauth_subject)
  WHERE oauth_provider IS NOT NULL;

-- ─── Phase 5: Execution job enhancements ──────────────────────────────────────
-- Add OPA policy result column to execution_jobs for audit trail

DO $$
BEGIN
  ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS policy_results JSONB DEFAULT '[]';
  ALTER TABLE execution_jobs ADD COLUMN IF NOT EXISTS policy_blocked  BOOLEAN DEFAULT false;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping Phase-5 execution_jobs columns: insufficient privilege';
END
$$;

-- ─── Phase 5: Project visibility ──────────────────────────────────────────────
-- Allow projects to be made "public" (read-only) within the platform

DO $$
BEGIN
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'private'
    CHECK (visibility IN ('private', 'team', 'public'));
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping Phase-5 projects.visibility column: insufficient privilege';
END
$$;

-- ─── Register this migration ──────────────────────────────────────────────────
-- Note: the migrate.js runner does this automatically; this INSERT is only
-- needed when applying via psql directly without the runner.
INSERT INTO schema_migrations (version, filename)
VALUES ('011', '011_phases_2_5_governance_collab_notifications.sql')
ON CONFLICT (version) DO NOTHING;
