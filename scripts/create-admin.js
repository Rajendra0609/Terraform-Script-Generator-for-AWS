#!/usr/bin/env node
'use strict';
/**
 * scripts/create-admin.js
 *
 * SECURITY FIX (C-11): a dedicated, operator-run CLI path for creating (or
 * promoting) an admin account — the alternative the audit report offered to
 * the ADMIN_BOOTSTRAP_TOKEN approach already implemented in
 * backend/routes/auth.js's POST /register:
 *
 *   "Or seed the admin account explicitly via a dedicated CLI/migration
 *    script, not the public HTTP API."
 *
 * Why this is safer than any public HTTP endpoint, even a token-gated one:
 * it requires whoever runs it to already have shell access to the backend
 * container/host (and therefore DATABASE_URL) — there is no network path an
 * outside attacker can reach at all, unlike POST /register which is
 * necessarily internet-facing.
 *
 * Usage (from the backend/ directory, or anywhere with DATABASE_URL set):
 *
 *   node scripts/create-admin.js --email you@company.com
 *   node scripts/create-admin.js --email you@company.com --password 'Sup3rSecret!'
 *   node scripts/create-admin.js --promote --email existing-user@company.com
 *
 * Behaviour:
 *   - If the email doesn't exist yet: creates a new user with role='admin'
 *     and email_verified=true (an operator running this by hand has, by
 *     definition, already verified they control this deployment — no need
 *     to make them click an email link too).
 *   - If the email already exists: fails UNLESS --promote is passed, in
 *     which case it flips role to 'admin' on the existing row (password is
 *     left untouched).
 *   - Prompts for a password interactively if --password isn't given, so
 *     the plaintext password never ends up in shell history.
 */

const readline = require('readline');
const path = require('path');

// Reuse the backend's own DB pool + bcrypt so this script hashes passwords
// with the exact same settings (cost factor, etc.) the app itself uses.
const db = require(path.join(__dirname, '../backend/db/connection'));
const bcrypt = require(path.join(__dirname, '../backend/node_modules/bcryptjs'));

function parseArgs(argv) {
  const out = { promote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--promote') out.promote = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Best-effort password masking — good enough for an ops CLI tool, not
    // trying to be a full TTY password prompt library.
    const stdin = process.stdin;
    process.stdout.write(question);
    let input = '';
    const onData = (char) => {
      char = char.toString('utf8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (char === '\u0003') {
        process.exit(1);
      } else if (char === '\u007f') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.email) {
    console.log(`
Usage:
  node scripts/create-admin.js --email you@company.com [--password 'Secret123!'] [--promote]

  --email      required. Address for the new (or existing, with --promote) admin.
  --password   optional. If omitted, you'll be prompted (not echoed to the terminal).
  --promote    promote an EXISTING user to admin instead of creating a new one.
`);
    process.exit(args.help ? 0 : 1);
  }

  const email = args.email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Error: not a valid email address:', email);
    process.exit(1);
  }

  try {
    const existing = await db.query('SELECT id, role FROM users WHERE email=$1', [email]);

    if (existing.rows.length) {
      if (!args.promote) {
        console.error(
          `Error: a user with email ${email} already exists (role: ${existing.rows[0].role}).\n` +
          `Re-run with --promote to make this existing account an admin instead.`
        );
        process.exit(1);
      }
      await db.query('UPDATE users SET role=$1 WHERE id=$2', ['admin', existing.rows[0].id]);
      console.log(`✅ Promoted existing user ${email} to admin.`);
    } else {
      let password = args.password;
      if (!password) {
        password = await promptHidden('Set a password for the new admin account: ');
      }
      if (!password || password.length < 8) {
        console.error('Error: password must be at least 8 characters.');
        process.exit(1);
      }
      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(password, salt);
      // email_verified=true: an operator running a shell script against the
      // production DATABASE_URL has already proven far more than clicking
      // an email link would.
      await db.query(
        `INSERT INTO users (email, password_hash, role, email_verified)
         VALUES ($1, $2, 'admin', true)`,
        [email, hash]
      );
      console.log(`✅ Created new admin account: ${email}`);
    }
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
