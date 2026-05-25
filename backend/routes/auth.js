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

const PASSWORD_MIN_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
  }
  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    // First registered user gets admin role automatically; all subsequent users get 'user'
    const countResult = await db.query('SELECT COUNT(*) FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count, 10) === 0;
    const assignedRole = isFirstUser ? 'admin' : 'user';

    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(password, salt);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at',
      [email.toLowerCase(), password_hash, assignedRole]
    );
    const user = result.rows[0];
    const { accessToken, refreshToken } = await issueTokens(user);
    // BUG-008 fix: refresh token goes in an HttpOnly cookie, never in the response body.
    // JS running in the page (including XSS) cannot read HttpOnly cookies.
    setRefreshCookie(res, refreshToken);
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
    res.status(201).json({ token: accessToken, user: safeUser(user) });
  } catch (e) {
    console.error('[auth] register error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
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
    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
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
  res.clearCookie('refreshToken', { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ success: true });
});

// ─── Get current user ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT id, email, role, created_at FROM users WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch user' }); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeUser(u) { return { id: u.id, email: u.email, role: u.role, created_at: u.created_at }; }
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
