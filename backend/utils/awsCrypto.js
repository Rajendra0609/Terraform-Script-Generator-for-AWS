'use strict';
/**
 * Shared AWS-credential encryption helpers.
 *
 * Extracted from routes/aws.js so routes/terraform.js (POST /apply) can
 * decrypt a user's stored AWS credentials without duplicating the
 * AES-256-GCM logic or the ENCRYPT_KEY fail-fast check.
 *
 * IMPORTANT: this module throws at require()-time if ENCRYPT_KEY is unset
 * or still the insecure default — exactly like the old inline check in
 * aws.js. Anything that requires this module eagerly at the top of the
 * file will crash the process the same way aws.js always did if the key is
 * missing. Routes that only need it conditionally (like terraform.js's
 * apply handler) should require() it lazily inside the handler so a
 * missing key surfaces as a normal 500 response instead of taking down
 * server startup from an unrelated route file.
 */
const crypto = require('crypto');
const db = require('../db/connection');

const ENCRYPT_KEY_RAW = process.env.ENCRYPT_KEY;
const INSECURE_DEFAULT = 'tfgen-dev-encrypt-key-32-chars!!';
if (!ENCRYPT_KEY_RAW || ENCRYPT_KEY_RAW === INSECURE_DEFAULT) {
  throw new Error(
    '[FATAL] ENCRYPT_KEY environment variable is not set or is still the insecure default. ' +
    'Generate a strong random value (e.g. openssl rand -hex 32) and add it to backend/.env before starting.'
  );
}
const ENCRYPT_KEY = crypto.createHash('sha256').update(ENCRYPT_KEY_RAW).digest();

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  const parts = ciphertext.split(':');
  const iv  = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const enc = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

/**
 * Look up and decrypt the stored AWS credentials for a user.
 * Returns null if the user has no credentials saved (caller should treat
 * that as "cannot run apply" rather than silently falling back to mock
 * creds — apply must never run against fake/placeholder credentials).
 */
async function getDecryptedAwsCredentials(userId) {
  if (!userId) return null;
  const row = await db.query(
    'SELECT access_key_id, secret_key_enc, aws_region FROM user_aws_credentials WHERE user_id = $1',
    [userId]
  );
  if (!row.rows.length) return null;
  const r = row.rows[0];
  return {
    accessKeyId:     r.access_key_id,
    secretAccessKey: decrypt(r.secret_key_enc),
    region:          r.aws_region,
  };
}

/**
 * Cheap existence check — does this user have AWS credentials saved at all?
 * Does NOT decrypt anything. Used by route handlers that need to reject
 * early (e.g. "no credentials saved" on POST /apply) WITHOUT pulling the
 * decrypted secret into memory before it's actually needed at execution
 * time — see the SECURITY FIX comment in routes/terraform.js / services/
 * terraformJobs.js (C-06) for why decrypted credentials must never be
 * fetched any earlier than the moment runPlan()/runApply() is about to use
 * them, since anything fetched at request time historically ended up
 * serialized into the BullMQ job payload in Redis.
 */
async function hasAwsCredentials(userId) {
  if (!userId) return false;
  const row = await db.query(
    'SELECT 1 FROM user_aws_credentials WHERE user_id = $1',
    [userId]
  );
  return row.rows.length > 0;
}

module.exports = { encrypt, decrypt, getDecryptedAwsCredentials, hasAwsCredentials, ENCRYPT_KEY };
