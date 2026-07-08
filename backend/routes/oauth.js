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
 *
 * ── Round-3 security audit fixes applied in this file ─────────────────────
 *   C-11 — OAuth signup no longer ever auto-grants admin (that path now
 *          exists ONLY in routes/auth.js's /register, gated by
 *          ADMIN_BOOTSTRAP_TOKEN, and in scripts/create-admin.js).
 *   C-12 — upsertOAuthUser() now refuses to auto-link an OAuth identity to
 *          an existing local account by email match unless that account is
 *          already email_verified. Closes the account pre-hijacking chain:
 *          an attacker who pre-registered the victim's address (see the
 *          C-12 fix in routes/auth.js) can no longer have the victim's
 *          later "Sign in with Google" silently merged into their account.
 *   H-05 — issueTokensAndRedirect() now reuses routes/auth.js's exported
 *          setRefreshCookie()/issueTokens() instead of maintaining its own
 *          drifted copy (wrong cookie path + sameSite: 'lax' meant logout
 *          never actually cleared the OAuth-issued cookie).
 *   M-02 — Google's id_token is now verified (signature + aud + iss + exp)
 *          via google-auth-library's OAuth2Client.verifyIdToken() instead of
 *          a manual, unverified base64 JWT payload decode. email_verified
 *          is also checked before the address is trusted, which C-12's
 *          link-by-email gate depends on.
 */

const router   = require('express').Router();
const https    = require('https');
const crypto   = require('crypto');
const db       = require('../db/connection');
const { setRefreshCookie, issueTokens } = require('./auth');

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

/** Thrown when an OAuth identity can't be linked to an existing local
 * account because that account hasn't confirmed its email yet (C-12). The
 * callback handlers catch this specifically to show a clear, actionable
 * message instead of the generic "authentication failed". */
class UnverifiedAccountError extends Error {
  constructor(email) {
    super(
      `An account already exists for ${email} but hasn't verified its email yet. ` +
      `Check your inbox for the verification link, or use "Forgot password" to regain access, ` +
      `before signing in with this provider.`
    );
    this.name = 'UnverifiedAccountError';
  }
}

// ── Shared: upsert user after OAuth ──────────────────────────────────────────
async function upsertOAuthUser({ email, displayName, avatarUrl, provider, subject, emailVerifiedByProvider }) {
  // Check if user exists by oauth_subject first (fastest path)
  const bySubject = await db.query(
    'SELECT * FROM users WHERE oauth_provider=$1 AND oauth_subject=$2',
    [provider, subject]
  ).catch(() => ({ rows: [] }));

  if (bySubject.rows.length) {
    const user = bySubject.rows[0];
    const { rows } = await db.query(
      'UPDATE users SET display_name=$1, avatar_url=$2, last_login_at=NOW() WHERE id=$3 RETURNING *',
      [displayName, avatarUrl, user.id]
    ).catch(() => ({ rows: [user] })); // fall back to the pre-update row if the UPDATE itself errors
    return rows[0] || user;
  }

  // Check by email (link existing account)
  const byEmail = await db.query(
    'SELECT * FROM users WHERE email=$1',
    [email.toLowerCase()]
  ).catch(() => ({ rows: [] }));

  if (byEmail.rows.length) {
    const existingUser = byEmail.rows[0];
    // SECURITY FIX (C-12): only auto-link when the existing row has already
    // confirmed ownership of this email address. Without this check, an
    // attacker who pre-registered someone else's address (which used to
    // succeed instantly, before C-12's verification requirement) would have
    // the real owner's OAuth login silently merged into the attacker's
    // account the first time the real owner signed in with Google/GitHub —
    // full account takeover using credentials the attacker set themselves.
    if (!existingUser.email_verified) {
      throw new UnverifiedAccountError(email);
    }
    const { rows } = await db.query(
      `UPDATE users SET oauth_provider=$1, oauth_subject=$2, display_name=$3,
       avatar_url=$4, last_login_at=NOW() WHERE id=$5 RETURNING *`,
      [provider, subject, displayName, avatarUrl, existingUser.id]
    ).catch(() => ({ rows: [existingUser] }));
    return rows[0] || existingUser;
  }

  // SECURITY FIX (C-11): OAuth signup NEVER auto-grants admin, regardless of
  // whether this is the very first account in the system. Admin bootstrap
  // is now only possible via routes/auth.js's ADMIN_BOOTSTRAP_TOKEN-gated
  // /register, or scripts/create-admin.js. An OAuth-created account starts
  // as email_verified=true — the provider has already done the work of
  // confirming ownership of the address (Google always sets
  // email_verified on its id_token; for GitHub we only ever pass in an
  // address that came back with verified: true — see the /github/callback
  // handler below), so there's no reason to make them click a TFGen
  // verification link on top of that.
  const { rows } = await db.query(`
    INSERT INTO users (email, password_hash, role, oauth_provider, oauth_subject,
                       display_name, avatar_url, last_login_at, email_verified)
    VALUES ($1, '', 'user', $2, $3, $4, $5, NOW(), $6)
    RETURNING *
  `, [email.toLowerCase(), provider, subject, displayName, avatarUrl, !!emailVerifiedByProvider]);

  return rows[0];
}

async function issueTokensAndRedirect(res, user, errorMsg) {
  if (errorMsg) {
    return res.redirect(`${FRONTEND_URL}/login?oauth_error=${encodeURIComponent(errorMsg)}`);
  }
  // SECURITY FIX (H-05): previously duplicated (with a drifted, wrong
  // cookie path + sameSite: 'lax') instead of reusing routes/auth.js's
  // setRefreshCookie()/issueTokens(). That drift meant POST /api/auth/logout
  // (which clears the cookie using the PASSWORD-login path's exact path)
  // never matched the OAuth-issued cookie's implicit path — logout silently
  // failed to log OAuth users out. Sharing one implementation makes that
  // class of bug structurally impossible to reintroduce.
  const { accessToken, refreshToken } = await issueTokens(user);
  setRefreshCookie(res, refreshToken);

  // Redirect to frontend with access token in fragment (never in query string)
  return res.redirect(`${FRONTEND_URL}/oauth-callback#token=${accessToken}`);
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = `${OAUTH_REDIRECT_BASE}/api/auth/oauth/google/callback`;

// SECURITY FIX (M-02): verify the id_token's signature + aud + iss + exp via
// Google's published JWKS instead of a manual, unverified base64 decode of
// the payload. Constructed lazily (only once GOOGLE_CLIENT_ID is confirmed
// present) so this module doesn't require Google env vars to load at all.
let _googleOAuthClient = null;
function getGoogleOAuthClient() {
  if (!_googleOAuthClient) {
    const { OAuth2Client } = require('google-auth-library');
    _googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  }
  return _googleOAuthClient;
}

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

    // SECURITY FIX (M-02): verifyIdToken() checks the RS256 signature
    // against Google's live JWKS, and validates `aud` (matches our own
    // client ID — rejects a token minted for a different app) and `iss`/
    // `exp`. This is the one step in the whole exchange that was previously
    // skipped entirely.
    const ticket = await getGoogleOAuthClient().verifyIdToken({
      idToken: tokenRes.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) throw new Error('Google id_token verification returned no payload');

    // SECURITY FIX (C-12 / M-02): only trust this address for account
    // linking purposes if Google itself says it's verified. Google
    // generally only issues id_tokens for verified addresses, but checking
    // explicitly costs nothing and removes any doubt.
    if (payload.email && !payload.email_verified) {
      throw new Error('Google account email is not verified');
    }

    const user = await upsertOAuthUser({
      email:       payload.email,
      displayName: payload.name,
      avatarUrl:   payload.picture,
      provider:    'google',
      subject:     payload.sub,
      emailVerifiedByProvider: true,
    });

    await issueTokensAndRedirect(res, user, null);
  } catch (e) {
    if (e instanceof UnverifiedAccountError) {
      console.warn('[oauth/google] blocked auto-link to unverified account:', e.message);
      return issueTokensAndRedirect(res, null, e.message);
    }
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

    // SECURITY FIX (C-12): the previous fallback — `primary?.email ||
    // emailsData[0]?.email` — could fall back to the FIRST email in the
    // list with no verified check at all, letting someone claim an address
    // as their OAuth identity that they never actually confirmed with
    // GitHub. Every path below now requires verified === true; if nothing
    // verified is available, we refuse rather than guess.
    let email = null;
    if (Array.isArray(emailsData)) {
      const primaryVerified = emailsData.find(e => e.primary && e.verified);
      const anyVerified      = emailsData.find(e => e.verified);
      email = primaryVerified?.email || anyVerified?.email || null;
    }
    // ghUser.email (from GET /user) is GitHub's own publicly-displayed
    // profile email — GitHub does not allow setting this to an address that
    // isn't already a verified email on the account, so it's an acceptable
    // fallback, but only if the emails endpoint gave us nothing usable.
    if (!email && ghUser.email) email = ghUser.email;
    if (!email) throw new Error('No verified email available from GitHub. Verify an email address in your GitHub settings and try again.');

    const user = await upsertOAuthUser({
      email,
      displayName: ghUser.name || ghUser.login,
      avatarUrl:   ghUser.avatar_url,
      provider:    'github',
      subject:     String(ghUser.id),
      emailVerifiedByProvider: true,
    });

    await issueTokensAndRedirect(res, user, null);
  } catch (e) {
    if (e instanceof UnverifiedAccountError) {
      console.warn('[oauth/github] blocked auto-link to unverified account:', e.message);
      return issueTokensAndRedirect(res, null, e.message);
    }
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
// Exported for the CI smoke test (tests/integration/oauth.integration.test.js)
// that exercises upsertOAuthUser() against a schema built the same way the
// shipped Postgres image is built — see C-13.
module.exports.upsertOAuthUser = upsertOAuthUser;
module.exports.UnverifiedAccountError = UnverifiedAccountError;
