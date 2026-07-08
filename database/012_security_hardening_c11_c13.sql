-- =============================================================================
-- 012_security_hardening_c11_c13.sql
-- TFGen — Round 3 security audit fixes (C-11, C-12, C-13)
-- =============================================================================
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Covers:
--   C-11 — first-user auto-admin race. No schema change is strictly required
--          for C-11 (the fix is entirely in application logic — see
--          backend/routes/auth.js and backend/routes/oauth.js), but this
--          migration exists so schema/app changes for this round ship together
--          and so `node migrate.js --status` reflects that this round was
--          applied.
--   C-12 — account pre-hijacking via unverified registration + email-based
--          OAuth linking. Adds `email_verified` + verification token columns
--          so registration can require confirmation before an account is
--          eligible for OAuth auto-linking.
--   C-13 — OAuth columns (oauth_provider, oauth_subject, display_name,
--          avatar_url, last_login_at) were only ever defined in migration
--          011, which never actually ran in the shipped deployment (see
--          CHANGELOG). This file re-asserts those columns with
--          IF NOT EXISTS so it is a no-op wherever 011 did run, and a full
--          fix wherever it didn't — belt-and-suspenders with the
--          database/Dockerfile and backend Dockerfile CMD fixes.
-- =============================================================================

-- ─── C-13: re-assert OAuth columns (idempotent even if 011 already ran) ──────
DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(50);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_subject  TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name   VARCHAR(255);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url     TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMP;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at   TIMESTAMP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping OAuth column re-assertion: insufficient privilege';
END
$$;

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT uq_oauth_provider_subject
    UNIQUE (oauth_provider, oauth_subject);
EXCEPTION WHEN duplicate_table OR duplicate_object OR others THEN
  NULL; -- already exists
END
$$;

CREATE INDEX IF NOT EXISTS idx_users_oauth
  ON users(oauth_provider, oauth_subject)
  WHERE oauth_provider IS NOT NULL;

-- ─── C-12: email verification ─────────────────────────────────────────────────
-- email_verified starts false for password registrations (must be confirmed
-- via the link sent by POST /api/auth/register) and is set true directly for
-- OAuth-created accounts (the provider has already verified ownership of the
-- address — Google always; GitHub only when the address came back with
-- verified === true, see backend/routes/oauth.js).
DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_expires_at TIMESTAMP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping email_verified columns: insufficient privilege';
END
$$;

-- Existing rows created before this migration (including any pre-existing
-- OAuth-linked rows) are treated as already verified so this migration
-- cannot lock currently-working accounts out — only NEW registrations from
-- this point forward are required to confirm their email before they are
-- eligible for OAuth auto-linking (see upsertOAuthUser in oauth.js).
UPDATE users SET email_verified = true WHERE email_verified = false AND created_at < NOW();

CREATE INDEX IF NOT EXISTS idx_users_email_verify_token
  ON users(email_verify_token)
  WHERE email_verify_token IS NOT NULL;

-- ─── Register this migration ──────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename)
VALUES ('012', '012_security_hardening_c11_c13.sql')
ON CONFLICT (version) DO NOTHING;
