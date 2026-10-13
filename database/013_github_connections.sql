-- 013_github_connections.sql
-- Per-user GitHub personal access token used by /api/github.
--
-- The token is stored ENCRYPTED (AES-256-GCM via backend/utils/awsCrypto.js,
-- keyed from ENCRYPT_KEY). It is never returned by any API. Deleting the user
-- deletes the connection (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS github_connections (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_token TEXT NOT NULL,
  login           VARCHAR(255) NOT NULL,
  scopes          TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
