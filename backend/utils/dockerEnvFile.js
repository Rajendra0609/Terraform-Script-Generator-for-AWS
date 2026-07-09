'use strict';
/**
 * SECURITY FIX (M-07): secrets (AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
 * INFRACOST_API_KEY, etc.) used to be passed to `docker run` as `-e
 * KEY=VALUE` CLI arguments (backend/terraform/runner.js's runInDocker(),
 * backend/services/infracost.js). Anything on a process's own command line
 * is visible to any other local user/process for the entire lifetime of
 * that process, via `ps auxww` or `/proc/<pid>/cmdline` — a much wider
 * blast radius than intended for AWS credentials.
 *
 * Docker's `--env-file` flag reads KEY=VALUE pairs from a file instead,
 * which never appears in `docker`'s own argv. This module writes that file
 * with `0600` permissions (readable only by the user this Node process runs
 * as) and returns a `cleanup()` that removes it once the container has been
 * launched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Docker's env-file format is simple KEY=VALUE lines with no quoting or
// escaping support — a literal newline embedded in a value would be
// misread as the start of a new (bogus) variable. None of the secrets this
// app handles (AWS keys/tokens, API keys) legitimately contain newlines, so
// stripping them is a safe, defensive no-op for real values and prevents a
// malformed value from corrupting the file format.
function sanitizeEnvValue(v) {
  return String(v).replace(/\r?\n/g, '');
}

/**
 * Write a temporary --env-file containing `envObj`'s keys/values.
 * Returns { filePath, dockerArgs, cleanup }:
 *   - dockerArgs: ready to splice into a `docker run` argv, e.g.
 *     args.push(...envFile.dockerArgs)
 *   - cleanup(): removes the file. Always call this once the docker
 *     process has been spawned (on success, failure, or timeout) so the
 *     file doesn't linger on disk.
 */
function writeEnvFile(envObj) {
  const fileName = `tfgen-envfile-${crypto.randomBytes(16).toString('hex')}.env`;
  const filePath = path.join(os.tmpdir(), fileName);

  const contents = Object.entries(envObj)
    .map(([k, v]) => `${k}=${sanitizeEnvValue(v)}`)
    .join('\n') + '\n';

  // `mode` here is applied at file-creation time (part of the open() call
  // fs.writeFileSync makes), not via a separate chmod() afterwards — that
  // matters because a separate chmod would leave a brief window where the
  // file is created with the process's default (umask-derived) permissions
  // and is world/group-readable before the chmod lands.
  fs.writeFileSync(filePath, contents, { mode: 0o600 });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.unlinkSync(filePath); } catch (_) { /* already gone / never created */ }
  };

  return { filePath, dockerArgs: ['--env-file', filePath], cleanup };
}

module.exports = { writeEnvFile };
