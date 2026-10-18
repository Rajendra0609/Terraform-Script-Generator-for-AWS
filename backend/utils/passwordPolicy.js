'use strict';
/**
 * Password policy — complexity bar + breached-password screening.
 *
 * SECURITY FIX (L-07): the only requirement at both registration and reset
 * was `password.length < PASSWORD_MIN_LENGTH` (8) — no complexity
 * requirement, no breached-password check, no defense against the very
 * common case of a technically-8+-character but trivially guessable
 * password ("password1", "12345678", etc). (Per-account failed-login
 * throttling, the third item in this finding, was already addressed
 * separately — see server.js's loginPerAccountLimiter.)
 *
 * Two independent, complementary checks:
 *  1. checkPasswordComplexity() — a modest, synchronous baseline: reject
 *     purely-numeric passwords and a small set of catastrophically common
 *     passwords, as a check that still works if the network call below is
 *     unavailable. Deliberately NOT a strict "must contain uppercase +
 *     lowercase + digit + symbol" composition rule — NIST SP 800-63B
 *     specifically recommends against mandatory composition rules (they
 *     push users toward predictable patterns like "Password1!") in favor of
 *     length + breached-password screening, which is what check #2 does.
 *  2. checkPasswordBreached() — HIBP's Pwned Passwords API via k-anonymity:
 *     only the first 5 hex characters of the password's SHA-1 hash are ever
 *     sent over the network, never the password itself or its full hash.
 *     Fails OPEN (network error / API unreachable / timeout => treated as
 *     "not known to be breached") so a third-party outage can never block
 *     registration or password reset — consistent with this codebase's
 *     general graceful-degradation philosophy (Redis-optional OAuth state,
 *     Docker-optional Terraform execution, etc).
 */
const https = require('https');
const crypto = require('crypto');

const HIBP_TIMEOUT_MS = 3000;
const HIBP_HOST = 'api.pwnedpasswords.com';

// A tiny, deliberately small synchronous blocklist — not a substitute for
// the HIBP check (which covers billions of real breached passwords), just
// a zero-network-dependency backstop for the most catastrophic cases.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  'qwertyui', 'qwerty123', 'letmein1', 'iloveyou', 'admin1234',
  'welcome1', 'changeme', 'abc12345', '11111111', '00000000',
]);

/**
 * Synchronous baseline complexity check. Returns null if OK, or an error
 * message string to show the user.
 */
function checkPasswordComplexity(password) {
  // A password made only of whitespace is technically 8+ characters but protects nothing.
  if (!password || password.trim().length === 0) {
    return 'Password cannot be only whitespace.';
  }
  if (/^\d+$/.test(password)) {
    return 'Password cannot be all numbers.';
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'This password is too common. Please choose a different one.';
  }
  return null;
}

/**
 * Check `password` against HIBP's Pwned Passwords k-anonymity API.
 * Returns { breached: boolean, count?: number, checked: boolean } —
 * `checked: false` means the API couldn't be reached and the check was
 * skipped (fail-open), NOT that the password is confirmed safe.
 */
function checkPasswordBreached(password) {
  return new Promise((resolve) => {
    const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const reqOut = https.request(
      {
        host: HIBP_HOST,
        path: `/range/${prefix}`,
        method: 'GET',
        headers: { 'Add-Padding': 'true' }, // HIBP-supported response padding (privacy hardening)
        timeout: HIBP_TIMEOUT_MS,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return resolve({ breached: false, checked: false });
        }
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          const line = body.split('\n').find(l => l.trim().toUpperCase().startsWith(suffix));
          if (!line) return resolve({ breached: false, checked: true });
          const count = parseInt((line.split(':')[1] || '0').trim(), 10);
          resolve({ breached: count > 0, count, checked: true });
        });
        response.on('error', () => resolve({ breached: false, checked: false }));
      }
    );
    reqOut.on('error', () => resolve({ breached: false, checked: false }));
    reqOut.on('timeout', () => { reqOut.destroy(); resolve({ breached: false, checked: false }); });
    reqOut.end();
  });
}

/**
 * Full policy check combining both layers. Returns null if the password is
 * acceptable, or a user-facing error string otherwise.
 */
async function validatePassword(password) {
  const complexityError = checkPasswordComplexity(password);
  if (complexityError) return complexityError;

  const { breached } = await checkPasswordBreached(password);
  if (breached) {
    return 'This password has appeared in a known data breach. Please choose a different password.';
  }
  return null;
}

module.exports = { checkPasswordComplexity, checkPasswordBreached, validatePassword };
