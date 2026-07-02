'use strict';
/**
 * /api/auth/oauth — OAuth 2.0 / OIDC scaffold for Google and GitHub
 *
 * Flow:
 *   1. Browser navigates to /api/auth/oauth/google (or /github)
 *   2. Server redirects to provider's authorization URL
 *   3. Provider redirects back to /api/auth/oauth/google/callback
 *   4. Server exchanges code → tokens → user info → issues TFGen JWT
 *   5. Redirect to frontend with access token in URL fragment
 *
 * Prerequisites (set in backend/.env):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *   OAUTH_REDIRECT_BASE  — e.g. http://localhost:4000  (where backend lives)
 *   FRONTEND_URL         — e.g. http://localhost:3000  (where frontend lives)
 *
 * To register your app:
 *   Google:  https://console.cloud.google.com/apis/credentials
 *   GitHub:  https://github.com/settings/developers
 *
 * Set the callback URIs:
 *   Google callback: {OAUTH_REDIRECT_BASE}/api/auth/oauth/google/callback
 *   GitHub callback: {OAUTH_REDIRECT_BASE}/api/auth/oauth/github/callback
 */

const router   = require('express').Router();
const https    = require('https');
const crypto   = require('crypto');
const db       = require('../db/connection');
const { signAccessToken, signRefreshToken } = require('../middleware/auth');

const FRONTEND_URL        = process.env.FRONTEND_URL        || 'http://localhost:3000';
const OAUTH_REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || 'http://localhost:4000';

// ── PKCE / state helpers ──────────────────────────────────────────────────────
function generateState() {
  return crypto.randomBytes(24).toString('base64url');
}

// In-process nonce store (use Redis for multi-instance deployments)
const _stateStore = new Map();
const STATE_TTL   = 10 * 60 * 1000; // 10 minutes

function storeState(state) {
  _stateStore.set(state, Date.now() + STATE_TTL);
  // Prune expired states (lazy GC)
  if (_stateStore.size > 500) {
    const now = Date.now();
    for (const [k, v] of _stateStore) { if (v < now) _stateStore.delete(k); }
  }
}

function consumeState(state) {
  const exp = _stateStore.get(state);
  if (!exp) return false;
  _stateStore.delete(state);
  return Date.now() < exp;
}

// ── Shared: upsert user after OAuth ──────────────────────────────────────────
async function upsertOAuthUser({ email, displayName, avatarUrl, provider, subject }) {
  // Check if user exists by oauth_subject first (fastest path)
  const bySubject = await db.query(
    'SELECT * FROM users WHERE oauth_provider=$1 AND oauth_subject=$2',
    [provider, subject]
  ).catch(() => ({ rows: [] }));

  if (bySubject.rows.length) {
    const user = bySubject.rows[0];
    await db.query(
      'UPDATE users SET display_name=$1, avatar_url=$2, last_login_at=NOW() WHERE id=$3',
      [displayName, avatarUrl, user.id]
    ).catch(() => {});
    return user;
  }

  // Check by email (link existing account)
  const byEmail = await db.query(
    'SELECT * FROM users WHERE email=$1',
    [email.toLowerCase()]
  ).catch(() => ({ rows: [] }));

  if (byEmail.rows.length) {
    const user = byEmail.rows[0];
    await db.query(
      `UPDATE users SET oauth_provider=$1, oauth_subject=$2, display_name=$3,
       avatar_url=$4, last_login_at=NOW() WHERE id=$5`,
      [provider, subject, displayName, avatarUrl, user.id]
    ).catch(() => {});
    return byEmail.rows[0];
  }

  // Create new user (first OAuth user gets admin if no users exist)
  const countRes = await db.query('SELECT COUNT(*) FROM users');
  const isFirst  = parseInt(countRes.rows[0].count, 10) === 0;

  const { rows } = await db.query(`
    INSERT INTO users (email, password_hash, role, oauth_provider, oauth_subject,
                       display_name, avatar_url, last_login_at)
    VALUES ($1, '', $2, $3, $4, $5, $6, NOW())
    RETURNING *
  `, [email.toLowerCase(), isFirst ? 'admin' : 'user', provider, subject, displayName, avatarUrl]);

  return rows[0];
}

function issueTokensAndRedirect(res, user, errorMsg) {
  if (errorMsg) {
    return res.redirect(`${FRONTEND_URL}/login?oauth_error=${encodeURIComponent(errorMsg)}`);
  }
  const accessToken  = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  // Store refresh token
  db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [user.id, crypto.createHash('sha256').update(refreshToken).digest('hex')]
  ).catch(() => {});

  // Set HttpOnly refresh cookie
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // Redirect to frontend with access token in fragment (never in query string)
  return res.redirect(`${FRONTEND_URL}/oauth-callback#token=${accessToken}`);
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = `${OAUTH_REDIRECT_BASE}/api/auth/oauth/google/callback`;

router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(501).json({
      error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env',
      setup: 'https://console.cloud.google.com/apis/credentials',
    });
  }
  const state = generateState();
  storeState(state);

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    state,
    access_type:   'offline',
    prompt:        'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return issueTokensAndRedirect(res, null, oauthError);
  if (!consumeState(state)) return issueTokensAndRedirect(res, null, 'Invalid or expired OAuth state');

  try {
    // Exchange code for tokens
    const tokenRes = await postJson('https://oauth2.googleapis.com/token', {
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
    });

    if (!tokenRes.id_token) throw new Error('No id_token in Google response');

    // Decode JWT payload (no signature verification — Google signs with RS256; use JWKS for prod)
    const payload = JSON.parse(
      Buffer.from(tokenRes.id_token.split('.')[1], 'base64url').toString()
    );

    const user = await upsertOAuthUser({
      email:       payload.email,
      displayName: payload.name,
      avatarUrl:   payload.picture,
      provider:    'google',
      subject:     payload.sub,
    });

    issueTokensAndRedirect(res, user, null);
  } catch (e) {
    console.error('[oauth/google] callback error:', e.message);
    issueTokensAndRedirect(res, null, 'Google authentication failed. Please try again.');
  }
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_REDIRECT_URI  = `${OAUTH_REDIRECT_BASE}/api/auth/oauth/github/callback`;

router.get('/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(501).json({
      error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in backend/.env',
      setup: 'https://github.com/settings/developers',
    });
  }
  const state = generateState();
  storeState(state);

  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope:        'read:user user:email',
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/github/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) return issueTokensAndRedirect(res, null, oauthError);
  if (!consumeState(state)) return issueTokensAndRedirect(res, null, 'Invalid or expired OAuth state');

  try {
    // Exchange code for access token
    const tokenRes = await postJson(
      'https://github.com/login/oauth/access_token',
      { code, client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, redirect_uri: GITHUB_REDIRECT_URI },
      { Accept: 'application/json' }
    );

    if (!tokenRes.access_token) throw new Error('No access_token in GitHub response');

    // Fetch user info
    const [ghUser, emailsData] = await Promise.all([
      getJson('https://api.github.com/user', { Authorization: `Bearer ${tokenRes.access_token}` }),
      getJson('https://api.github.com/user/emails', { Authorization: `Bearer ${tokenRes.access_token}` }),
    ]);

    // Pick primary email (GitHub can hide email)
    let email = ghUser.email;
    if (!email && Array.isArray(emailsData)) {
      const primary = emailsData.find(e => e.primary && e.verified);
      email = primary?.email || emailsData[0]?.email;
    }
    if (!email) throw new Error('No email available from GitHub. Enable email visibility in GitHub settings.');

    const user = await upsertOAuthUser({
      email,
      displayName: ghUser.name || ghUser.login,
      avatarUrl:   ghUser.avatar_url,
      provider:    'github',
      subject:     String(ghUser.id),
    });

    issueTokensAndRedirect(res, user, null);
  } catch (e) {
    console.error('[oauth/github] callback error:', e.message);
    issueTokensAndRedirect(res, null, e.message.includes('email') ? e.message : 'GitHub authentication failed.');
  }
});

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const { hostname, pathname, search, port } = new URL(url);
    const req = https.request({
      hostname, path: pathname + (search || ''),
      port: port || 443,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'TFGen/3.0',
        Accept: 'application/json',
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search, port } = new URL(url);
    https.get({
      hostname, path: pathname + (search || ''),
      port: port || 443,
      headers: { 'User-Agent': 'TFGen/3.0', Accept: 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

module.exports = router;
