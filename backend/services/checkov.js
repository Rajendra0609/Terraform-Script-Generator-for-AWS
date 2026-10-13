'use strict';
/**
 * Checkov IaC security scanner service.
 * Runs Checkov CLI inside the Docker sandbox or falls back to a static
 * rule-based linter when Docker/Checkov is unavailable.
 *
 * Docker image: bridgecrew/checkov (pinned via TF_CHECKOV_IMAGE env var).
 * Checkov docs: https://www.checkov.io/5.Policy%20Index/terraform.html
 */
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { randomUUID: uuidv4 } = require('crypto'); // built-in; replaces ESM-only 'uuid' pkg
const { isDockerAvailable } = require('../utils/dockerAvailable');
const { SCRATCH_MOUNT, SCRATCH_VOLUME_ARGS_RO, ensureScratchDir } = require('../utils/dockerScratch');

const CHECKOV_IMAGE = process.env.CHECKOV_IMAGE || 'bridgecrew/checkov:latest';
// SECURITY FIX (critical — see utils/dockerScratch.js): this used to live
// under os.tmpdir(), which only exists inside THIS container. Bind-mounting
// that path into a sibling `docker run` container silently produced an
// EMPTY /workspace there — meaning Checkov always scanned nothing and
// always returned 0 findings, so the "block plan on CRITICAL findings" gate
// could never actually fire, no matter how insecure the real HCL was.
const WORKSPACE = path.join(SCRATCH_MOUNT, 'checkov-workspaces');
ensureScratchDir(WORKSPACE);

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Block extractor ──────────────────────────────────────────────────────────
// ─── Static rule-based fallback ────────────────────────────────────────────────
// The rule implementations live in ./staticSecurityRules.js (block-aware, see
// that file's header for the defects this replaced). This wrapper keeps the
// original public signature used by terraformJobs.js and the unit tests.
const { evaluateStaticRules } = require('./staticSecurityRules');

function runStaticCheckov(hcl) {
  return evaluateStaticRules(hcl);
}

// ─── Docker Checkov runner ─────────────────────────────────────────────────────
async function runCheckov(hcl) {
  const useDocker = await isDockerAvailable();

  if (!useDocker) {
    return { ...runStaticCheckov(hcl), offline: true };
  }

  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  ensureScratchDir(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');

  const dockerCmd = [
    'docker run --rm',
    '--network=none --memory=256m --cpus=0.5 --pids-limit=20',
    '--user=1000:1000',
    // SECURITY FIX: shared named volume, not a broken host-path bind mount
    // (see utils/dockerScratch.js) — `workDir` is a real absolute path
    // under SCRATCH_MOUNT, valid unchanged inside the sibling container.
    ...SCRATCH_VOLUME_ARGS_RO,
    CHECKOV_IMAGE,
    'checkov', '--directory', workDir, '--output', 'json', '--quiet',
    '--framework', 'terraform',
    // Do not fail on findings — we parse the JSON ourselves
    '--soft-fail',
  ].join(' ');

  return new Promise((resolve) => {
    exec(dockerCmd, { timeout: 30000 }, (_, stdout, stderr) => {
      cleanup(workDir);
      try {
        const result = JSON.parse(stdout);
        const passed  = result.summary?.passed  ?? 0;
        const failed  = result.summary?.failed  ?? 0;
        const findings = (result.results?.failed_checks || []).map(c => ({
          check_id:      c.check_id,
          resource:      c.resource,
          severity:      c.severity || 'MEDIUM',
          message:       c.check?.name || c.check_id,
          file:          c.file_path,
          line:          c.file_line_range?.[0],
          guideline_url: c.guideline || `https://docs.bridgecrew.io/docs/${(c.check_id || '').toLowerCase()}`,
        }));
        resolve({ engine: 'checkov', passed, failed, total: passed + failed, findings });
      } catch (_) {
        // Checkov returned non-JSON (e.g., version not found) — fall back to static
        console.warn('[checkov] Could not parse Checkov JSON output, falling back to static rules');
        resolve({ ...runStaticCheckov(hcl), offline: true });
      }
    });
  });
}

module.exports = { runCheckov, runStaticCheckov };
