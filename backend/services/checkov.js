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
const { v4: uuidv4 } = require('uuid');
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
/**
 * Extract all top-level resource blocks of a given type from HCL text.
 * Uses brace-depth tracking so nested blocks (lifecycle {}, tags {}, etc.)
 * do not prematurely terminate extraction.
 *
 * Returns an array of objects: { resourceName, body }
 *   body = the text content between the outer { } of the resource block.
 */
function extractResourceBlocks(hcl, resourceType) {
  const blocks = [];
  // Match the opening line: resource "aws_s3_bucket" "my_bucket" {
  const headerRe = new RegExp(
    `resource\\s+"${resourceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+"([^"]+)"\\s*\\{`,
    'g'
  );
  let headerMatch;
  while ((headerMatch = headerRe.exec(hcl)) !== null) {
    const resourceName = headerMatch[1];
    // Walk forward from the opening brace tracking depth
    let depth = 1;
    let i = headerMatch.index + headerMatch[0].length;
    const bodyStart = i;
    while (i < hcl.length && depth > 0) {
      const ch = hcl[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    // hcl[bodyStart .. i-1] includes the closing brace; exclude it
    const body = hcl.slice(bodyStart, i - 1);
    blocks.push({ resourceName, body });
  }
  return blocks;
}

// ─── Static rule-based fallback ────────────────────────────────────────────────
// A curated subset of the most critical Checkov rules, implemented in JS so
// the feature works even without Docker/Checkov installed.
//
// Rules that apply per-resource-block use `testBlock(body, resourceName)`
// instead of `test(hcl)` so that false negatives are avoided when multiple
// resources of the same type exist and only some comply.
const STATIC_RULES = [
  {
    id: 'CKV_AWS_25', severity: 'CRITICAL', resource: 'aws_security_group',
    message: 'Security group should not allow ingress from 0.0.0.0/0 to port 22 (SSH)',
    test: (hcl) => /ingress[\s\S]{0,200}0\.0\.0\.0\/0[\s\S]{0,200}(from_port\s*=\s*22|to_port\s*=\s*22)/.test(hcl) ||
                   /ingress[\s\S]{0,200}(from_port\s*=\s*22|to_port\s*=\s*22)[\s\S]{0,200}0\.0\.0\.0\/0/.test(hcl),
  },
  {
    id: 'CKV_AWS_24', severity: 'CRITICAL', resource: 'aws_security_group',
    message: 'Security group should not allow ingress from 0.0.0.0/0 to port 3389 (RDP)',
    test: (hcl) => /ingress[\s\S]{0,200}0\.0\.0\.0\/0[\s\S]{0,200}(from_port\s*=\s*3389|to_port\s*=\s*3389)/.test(hcl) ||
                   /ingress[\s\S]{0,200}(from_port\s*=\s*3389|to_port\s*=\s*3389)[\s\S]{0,200}0\.0\.0\.0\/0/.test(hcl),
  },
  // ── S3 rules: tested per-block to avoid false negatives across multiple buckets ──
  {
    id: 'CKV_AWS_18', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have access logging enabled',
    // per-block: fires for each bucket that is missing a logging {} block
    testBlock: (body) => !/logging\s*{/.test(body),
  },
  {
    id: 'CKV_AWS_21', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have versioning enabled',
    testBlock: (body) => !/versioning\s*{/.test(body),
  },
  {
    id: 'CKV_AWS_19', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have server-side encryption enabled',
    testBlock: (body) => !/server_side_encryption_configuration\s*{/.test(body),
  },
  // ── EC2 rules: per-block ──────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_8', severity: 'MEDIUM', resource: 'aws_instance',
    message: 'EC2 instance should have encrypted EBS root volume',
    testBlock: (body) => !/encrypted\s*=\s*true/.test(body),
  },
  {
    id: 'CKV_AWS_135', severity: 'MEDIUM', resource: 'aws_instance',
    message: 'EC2 instance should have detailed monitoring enabled',
    testBlock: (body) => !/monitoring\s*=\s*true/.test(body),
  },
  // ── KMS ────────────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_7', severity: 'HIGH', resource: 'aws_kms_key',
    message: 'KMS key should have key rotation enabled',
    testBlock: (body) => !/enable_key_rotation\s*=\s*true/.test(body),
  },
  // ── RDS ────────────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_16', severity: 'HIGH', resource: 'aws_db_instance',
    message: 'RDS instance should have encryption at rest enabled',
    testBlock: (body) => !/storage_encrypted\s*=\s*true/.test(body),
  },
  {
    id: 'CKV_AWS_17', severity: 'HIGH', resource: 'aws_db_instance',
    message: 'RDS instance should not be publicly accessible',
    testBlock: (body) => /publicly_accessible\s*=\s*true/.test(body),
  },
  // ── ALB ────────────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_2', severity: 'HIGH', resource: 'aws_alb_listener',
    message: 'ALB listener should use HTTPS (port 443), not HTTP',
    testBlock: (body) => /port\s*=\s*["']?80["']?/.test(body),
  },
  // ── CloudTrail / EKS: whole-HCL tests remain (single-instance resources) ──────
  {
    id: 'CKV_AWS_91', severity: 'MEDIUM', resource: 'aws_cloudtrail',
    message: 'CloudTrail should have log file validation enabled',
    testBlock: (body) => !/enable_log_file_validation\s*=\s*true/.test(body),
  },
  {
    id: 'CKV_AWS_65', severity: 'MEDIUM', resource: 'aws_eks_cluster',
    message: 'EKS cluster should have secrets encryption enabled',
    testBlock: (body) => !/encryption_config\s*{/.test(body),
  },
];

function runStaticCheckov(hcl) {
  const findings = [];

  for (const rule of STATIC_RULES) {
    if (rule.testBlock) {
      // Per-block evaluation: extract all resource blocks of this type and
      // test each one independently.  This prevents a compliant bucket from
      // suppressing a finding on a sibling non-compliant bucket.
      const blocks = extractResourceBlocks(hcl, rule.resource);
      for (const { resourceName, body } of blocks) {
        if (rule.testBlock(body)) {
          findings.push({
            check_id:      rule.id,
            resource:      `${rule.resource}.${resourceName}`,
            severity:      rule.severity,
            message:       rule.message,
            guideline_url: `https://docs.bridgecrew.io/docs/${rule.id.toLowerCase()}`,
          });
        }
      }
    } else if (rule.test) {
      // Whole-HCL test for rules where per-block extraction is not needed
      // (e.g. security group ingress rules that span multiple sub-blocks)
      if (rule.test(hcl)) {
        findings.push({
          check_id:      rule.id,
          resource:      rule.resource,
          severity:      rule.severity,
          message:       rule.message,
          guideline_url: `https://docs.bridgecrew.io/docs/${rule.id.toLowerCase()}`,
        });
      }
    }
  }

  const total = STATIC_RULES.length;
  return {
    engine:  'static',
    passed:  total - findings.length,
    failed:  findings.length,
    total,
    findings,
  };
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
