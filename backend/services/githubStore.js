'use strict';
/**
 * Persists each user's GitHub token, encrypted at rest.
 *
 * awsCrypto.js throws at require()-time when ENCRYPT_KEY is missing, so it is
 * required lazily here: a missing key surfaces as an error on the GitHub
 * routes only, not as a crash at server start (same pattern as routes/terraform.js).
 */
const db = require('../db/connection');

let schemaReady = null;

/** Idempotent, memoised: creates the table on first use in this process. */
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS github_connections (
        user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_token TEXT NOT NULL,
        login           VARCHAR(255) NOT NULL,
        scopes          TEXT,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )`).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function saveConnection(userId, token, viewer) {
  await ensureSchema();
  const { encrypt } = require('../utils/awsCrypto');
  await db.query(
    `INSERT INTO github_connections (user_id, encrypted_token, login, scopes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET encrypted_token = EXCLUDED.encrypted_token,
           login = EXCLUDED.login,
           scopes = EXCLUDED.scopes,
           updated_at = NOW()`,
    [userId, encrypt(token), viewer.login, viewer.scopes || null]
  );
}

/** Metadata only — never includes the token. */
async function getConnectionMeta(userId) {
  await ensureSchema();
  const { rows } = await db.query(
    'SELECT login, scopes, created_at FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;
  return { login: rows[0].login, scopes: rows[0].scopes, connectedAt: rows[0].created_at };
}

/** Decrypted token for server-side calls. Only the GitHub routes use this. */
async function getConnection(userId) {
  await ensureSchema();
  const { rows } = await db.query(
    'SELECT encrypted_token, login FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;
  const { decrypt } = require('../utils/awsCrypto');
  return { token: decrypt(rows[0].encrypted_token), login: rows[0].login };
}

async function deleteConnection(userId) {
  await ensureSchema();
  const res = await db.query('DELETE FROM github_connections WHERE user_id = $1', [userId]);
  return res.rowCount > 0;
}

module.exports = { ensureSchema, saveConnection, getConnectionMeta, getConnection, deleteConnection };
