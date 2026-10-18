'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/connection');
const {
  authMiddleware,
  signAccessToken,
  signRefreshToken,
  JWT_REFRESH_SECRET,
} = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { sendPasswordReset, sendVerificationEmail } = require('../services/mailer');
const { validatePassword } = require('../utils/passwordPolicy');

// SECURITY FIX (C-11): arbitrary fixed key for the Postgres advisory lock
// that serialises the register endpoint's count-check + insert sequence.
// Any stable int works — this is just a namespacing convention so it can't
// collide with an advisory lock some other part of the app might take.
const ADVISORY_LOCK_KEY = 911411;

const PASSWORD_MIN_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// SECURITY FIX (C-11): ADMIN_BOOTSTRAP_TOKEN gates the ONLY remaining path
// by which the public, unauthenticated /register endpoint can mint an
// admin account. If unset (the default), NO ONE can become admin through
// this endpoint — operators must use `node scripts/create-admin.js` instead
// (see that script for why a dedicated CLI path is safer than any public
// HTTP endpoint). Deliberately has no default/fallback value — same
// fail-safe pattern as JWT_SECRET in middleware/auth.js, except the
// "insecure" state here is simply "feature disabled", not a crash, since
// admin bootstrap is optional.
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || null;

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid a length-based timing
    // signal, then report false.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, adminBootstrapToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (typeof email !== 'string' || email.length > 254) {
    return res.status(400).json({ error: 'Email address is too long (maximum 254 characters)' });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
  }
  // SECURITY FIX (L-07): length alone let through trivially guessable
  // passwords ("password1", "12345678", ...). validatePassword() adds a
  // modest complexity backstop plus an HIBP breached-password check (see
  // utils/passwordPolicy.js — fails open on network error, never blocks
  // registration because a third-party API is unreachable).
  const passwordError = await validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  try {
    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(password, salt);

    // SECURITY FIX (C-12): registration no longer creates a fully-verified,
    // immediately-linkable account. A random token is issued and emailed to
    // the address supplied; email_verified stays false until GET
    // /verify-email confirms it. upsertOAuthUser() (routes/oauth.js) refuses
    // to auto-link an OAuth identity to an unverified row by email match —
    // this is what actually closes the pre-hijacking chain described in
    // C-12: an attacker can still register someone else's address, but they
    // can no longer get the real owner's later "Sign in with Google" click
    // silently merged into the account they control.
    const rawVerifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = hashToken(rawVerifyToken);
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // SECURITY FIX (C-11): the count-check and insert used to be two
    // separate, unlocked statements — a straightforward TOCTOU race letting
    // two concurrent registrations both observe count===0 and both become
    // admin. pg_advisory_xact_lock serialises this specific check-then-insert
    // sequence for the lifetime of the transaction (auto-released on
    // COMMIT/ROLLBACK) without taking a table-level lock that would block
    // unrelated reads/writes to `users`.
    const user = await db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

      const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length > 0) {
        const err = new Error('Email already registered');
        err.statusCode = 409;
        throw err;
      }

      const countResult = await client.query('SELECT COUNT(*) FROM users');
      const isFirstUser = parseInt(countResult.rows[0].count, 10) === 0;

      // SECURITY FIX (C-11): the first registered user no longer becomes
      // admin unconditionally. Only when the operator has (a) actually set
      // ADMIN_BOOTSTRAP_TOKEN in their own .env — no shipped default — AND
      // (b) the registration request itself presented the matching token,
      // does the first account become admin. Any registration that doesn't
      // meet both conditions gets 'user', including the very first one — so
      // an opportunistic bot that registers before the real operator gets
      // nothing more than a normal account.
      const wantsBootstrap = isFirstUser && ADMIN_BOOTSTRAP_TOKEN && adminBootstrapToken
        && constantTimeEqual(adminBootstrapToken, ADMIN_BOOTSTRAP_TOKEN);
      const assignedRole = wantsBootstrap ? 'admin' : 'user';

      const result = await client.query(
        `INSERT INTO users (email, password_hash, role, email_verified, email_verify_token, email_verify_token_expires_at)
         VALUES ($1, $2, $3, false, $4, $5)
         RETURNING id, email, role, email_verified, created_at`,
        [email.toLowerCase(), password_hash, assignedRole, verifyTokenHash, verifyExpires]
      );
      return result.rows[0];
    });

    // Best-effort — never let a mail-server hiccup block registration.
    try {
      await sendVerificationEmail(email.toLowerCase(), rawVerifyToken);
    } catch (mailErr) {
      console.error('[auth] failed to send verification email:', mailErr.message);
    }

    const { accessToken, refreshToken } = await issueTokens(user);
    // BUG-008 fix: refresh token goes in an HttpOnly cookie, never in the response body.
    // JS running in the page (including XSS) cannot read HttpOnly cookies.
    setRefreshCookie(res, refreshToken);
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    res.status(201).json({ token: accessToken, user: safeUser(user) });
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message });
    console.error('[auth] register error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Verify email ─────────────────────────────────────────────────────────────
// SECURITY FIX (C-12): confirms ownership of the address used at
// registration. Until this succeeds, email_verified stays false and
// upsertOAuthUser() (routes/oauth.js) will refuse to auto-link an OAuth
// identity to this row by email match.
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Verification token required' });
  }
  try {
    const tokenHash = hashToken(token);
    const result = await db.query(
      `UPDATE users
       SET email_verified = true, email_verify_token = NULL, email_verify_token_expires_at = NULL
       WHERE email_verify_token = $1 AND email_verify_token_expires_at > NOW()
       RETURNING id, email`,
      [tokenHash]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Verification link is invalid or has expired.' });
    }
    res.json({ success: true, email: result.rows[0].email });
  } catch (e) {
    console.error('[auth] verify-email error:', e.message);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

// ─── Resend verification email ────────────────────────────────────────────────
router.post('/resend-verification', authMiddleware, async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, email, email_verified FROM users WHERE id = $1', [req.user.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = existing.rows[0];
    if (user.email_verified) return res.json({ success: true, alreadyVerified: true });

    const rawVerifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = hashToken(rawVerifyToken);
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.query(
      'UPDATE users SET email_verify_token=$1, email_verify_token_expires_at=$2 WHERE id=$3',
      [verifyTokenHash, verifyExpires, user.id]
    );
    await sendVerificationEmail(user.email, rawVerifyToken);
    res.json({ success: true });
  } catch (e) {
    console.error('[auth] resend-verification error:', e.message);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const { accessToken, refreshToken } = await issueTokens(user);
    // BUG-008 fix: refresh token in HttpOnly cookie only
    setRefreshCookie(res, refreshToken);
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    res.json({ token: accessToken, user: safeUser(user) });
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Refresh token ────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  // BUG-008 fix: read refresh token from HttpOnly cookie, not request body
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
  try {
    // SECURITY FIX (L-09): explicit algorithms allow-list — same rationale
    // as verifyAccessToken() in middleware/auth.js. Refresh tokens are
    // always signed HS256 (see signRefreshToken()).
    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    const tokenHash = hashToken(refreshToken);
    const stored = await db.query(
      `SELECT * FROM refresh_tokens WHERE user_id=$1 AND token_hash=$2 AND revoked=false AND expires_at>NOW()`,
      [payload.id, tokenHash]
    );
    if (!stored.rows.length) return res.status(401).json({ error: 'Refresh token invalid or expired' });
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE id=$1', [stored.rows[0].id]);
    const userRes = await db.query('SELECT id, email, role FROM users WHERE id=$1', [payload.id]);
    if (!userRes.rows.length) return res.status(401).json({ error: 'User not found' });
    const { accessToken, refreshToken: newRT } = await issueTokens(userRes.rows[0]);
    // Rotate the cookie with the new refresh token
    setRefreshCookie(res, newRT);
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    res.json({ token: accessToken });
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Refresh token invalid or expired' });
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', authMiddleware, async (req, res) => {
  // BUG-008 fix: read from HttpOnly cookie, then clear it
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1', [tokenHash]).catch(() => {});
  }
  // FIX: clearCookie must include the same `path` used in setRefreshCookie.
  // Without it the browser sees them as different cookies and never removes the
  // old one — the user appears logged out in-app but the cookie persists and
  // auto-logs them back in on the next page load via the /refresh call.
  res.clearCookie('refreshToken', {
    httpOnly : true,
    secure   : process.env.NODE_ENV !== 'development',
    sameSite : 'strict',
    path     : '/api/auth',
  });
  res.json({ success: true });
});

// ─── Get current user ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT id, email, role, email_verified, created_at FROM users WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch user' }); }
});

// ─── Forgot password ──────────────────────────────────────────────────────────
// Always returns 200 regardless of whether the email exists — prevents user
// enumeration attacks (attacker cannot tell if an address is registered).
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  try {
    const rawToken  = crypto.randomBytes(32).toString('hex');
    // FIX: store only the SHA-256 hash — mirrors the refresh-token pattern.
    // A compromised DB cannot be used to reset accounts via stolen reset tokens.
    const tokenHash = hashToken(rawToken);
    const expires   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    // Only store the token if the email actually exists; silently no-op otherwise.
    await db.query(
      'UPDATE users SET reset_token=$1, reset_token_expires_at=$2 WHERE email=$3',
      [tokenHash, expires, email.toLowerCase()]
    );
    // Send the reset email only when the address is actually registered.
    // We check the UPDATE rowCount so the API always returns 200 regardless
    // (prevents user-enumeration: caller cannot tell if an address exists).
    const updateResult = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (updateResult.rows.length > 0) {
      try {
        await sendPasswordReset(email.toLowerCase(), rawToken);
        console.info(`[auth] password reset email sent to ${email}`);
      } catch (mailErr) {
        // Log but never bubble mail errors to the client — they still get 200.
        console.error(`[auth] failed to send reset email to ${email}:`, mailErr.message);
      }
    } else {
      console.info(`[auth] password reset requested for unknown address ${email} — silently ignored`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[auth] forgot-password error:', e.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ─── Reset password ───────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password required' });
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
  }
  // SECURITY FIX (L-07): same policy as registration — see the comment
  // there and utils/passwordPolicy.js.
  const passwordError = await validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  try {
    // FIX: compare the hash of the supplied token against the stored hash —
    // never store or compare raw tokens (mirrors the refresh-token pattern).
    const tokenHash = hashToken(token);
    const result = await db.query(
      `SELECT id FROM users
       WHERE reset_token = $1
         AND reset_token_expires_at > NOW()`,
      [tokenHash]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'Reset token is invalid or has expired' });
    }
    const salt         = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(password, salt);
    await db.query(
      `UPDATE users
       SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL
       WHERE id = $2`,
      [password_hash, result.rows[0].id]
    );
    // Revoke all existing refresh tokens so old sessions cannot persist
    await db.query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [result.rows[0].id]).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error('[auth] reset-password error:', e.message);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeUser(u) { return { id: u.id, email: u.email, role: u.role, email_verified: !!u.email_verified, created_at: u.created_at }; }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

// BUG-008 fix: centralised helper that always sets the cookie with security flags
function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly : true,                   // not readable by JS
    secure   : process.env.NODE_ENV !== 'development', // HTTPS-only in prod
    sameSite : 'strict',               // no cross-site sends
    maxAge   : 7 * 24 * 60 * 60 * 1000, // 7 days — matches token lifetime
    path     : '/api/auth',            // narrowest path that covers /refresh & /logout
  });
}

// Ensure refresh_tokens table exists (safety net for DBs that haven't run migrations)
let _refreshTableChecked = false;
async function ensureRefreshTable() {
  if (_refreshTableChecked) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT      NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      revoked    BOOLEAN   DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)').catch(() => {});
  await db.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)').catch(() => {});
  _refreshTableChecked = true;
}

// BUG-012 fix: purge revoked and expired refresh tokens on a regular schedule.
// Without this, every login/register/refresh permanently appends a row to
// refresh_tokens — the table grows without bound, causing query slowdowns,
// storage bloat, and murky security forensics.
//
// The interval is registered once at module-load time (not per-request) and
// runs its first sweep after the initial delay so it doesn't block startup.
// Using .catch() ensures a transient DB error cannot crash the server process.
(function scheduleTokenCleanup() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
  setInterval(() => {
    db.query('DELETE FROM refresh_tokens WHERE revoked = true OR expires_at < NOW()')
      .then(r  => { if (r.rowCount > 0) console.info(`[auth] cleanup: removed ${r.rowCount} stale refresh token(s)`); })
      .catch(e => console.error('[auth] cleanup error:', e.message));
  }, INTERVAL_MS).unref(); // .unref() prevents the timer from keeping the process alive during tests
})();

async function issueTokens(user) {
  await ensureRefreshTable();
  const accessToken  = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const tokenHash    = hashToken(refreshToken);
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [user.id, tokenHash, expiresAt]);
  return { accessToken, refreshToken };
}

module.exports = router;
// SECURITY FIX (H-05): exported so routes/oauth.js can share the exact same
// cookie (path/sameSite/secure flags) and token-issuance logic instead of
// maintaining its own copy that silently drifted — see CHANGELOG for the
// "stale cookie after OAuth logout" bug this caused.
module.exports.setRefreshCookie = setRefreshCookie;
module.exports.issueTokens = issueTokens;
module.exports.hashToken = hashToken;
