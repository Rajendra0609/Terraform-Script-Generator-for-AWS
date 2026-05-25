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

const CHECKOV_IMAGE = process.env.CHECKOV_IMAGE || 'bridgecrew/checkov:latest';
const WORKSPACE     = path.join(os.tmpdir(), 'tfgen-checkov');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function isDockerAvailable() {
  return new Promise(resolve => exec('docker info', { timeout: 3000 }, err => resolve(!err)));
}

// ─── Static rule-based fallback ────────────────────────────────────────────────
// A curated subset of the most critical Checkov rules, implemented in JS so
// the feature works even without Docker/Checkov installed.
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
  {
    id: 'CKV_AWS_18', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have access logging enabled',
    test: (hcl) => /resource\s+"aws_s3_bucket"/.test(hcl) && !/logging\s*{/.test(hcl),
  },
  {
    id: 'CKV_AWS_21', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have versioning enabled',
    test: (hcl) => /resource\s+"aws_s3_bucket"/.test(hcl) && !/versioning\s*{/.test(hcl),
  },
  {
    id: 'CKV_AWS_19', severity: 'HIGH', resource: 'aws_s3_bucket',
    message: 'S3 bucket should have server-side encryption enabled',
    test: (hcl) => /resource\s+"aws_s3_bucket"/.test(hcl) && !/server_side_encryption_configuration\s*{/.test(hcl),
  },
  {
    id: 'CKV_AWS_8', severity: 'MEDIUM', resource: 'aws_instance',
    message: 'EC2 instance should have encrypted EBS root volume',
    test: (hcl) => /resource\s+"aws_instance"/.test(hcl) && !/encrypted\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_135', severity: 'MEDIUM', resource: 'aws_instance',
    message: 'EC2 instance should have detailed monitoring enabled',
    test: (hcl) => /resource\s+"aws_instance"/.test(hcl) && !/monitoring\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_7', severity: 'HIGH', resource: 'aws_kms_key',
    message: 'KMS key should have key rotation enabled',
    test: (hcl) => /resource\s+"aws_kms_key"/.test(hcl) && !/enable_key_rotation\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_16', severity: 'HIGH', resource: 'aws_db_instance',
    message: 'RDS instance should have encryption at rest enabled',
    test: (hcl) => /resource\s+"aws_db_instance"/.test(hcl) && !/storage_encrypted\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_17', severity: 'HIGH', resource: 'aws_db_instance',
    message: 'RDS instance should not be publicly accessible',
    test: (hcl) => /resource\s+"aws_db_instance"[\s\S]{0,500}publicly_accessible\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_2', severity: 'HIGH', resource: 'aws_alb_listener',
    message: 'ALB listener should use HTTPS (port 443), not HTTP',
    test: (hcl) => /resource\s+"aws_alb_listener"[\s\S]{0,200}port\s*=\s*["']?80["']?/.test(hcl),
  },
  {
    id: 'CKV_AWS_91', severity: 'MEDIUM', resource: 'aws_cloudtrail',
    message: 'CloudTrail should have log file validation enabled',
    test: (hcl) => /resource\s+"aws_cloudtrail"/.test(hcl) && !/enable_log_file_validation\s*=\s*true/.test(hcl),
  },
  {
    id: 'CKV_AWS_65', severity: 'MEDIUM', resource: 'aws_eks_cluster',
    message: 'EKS cluster should have secrets encryption enabled',
    test: (hcl) => /resource\s+"aws_eks_cluster"/.test(hcl) && !/encryption_config\s*{/.test(hcl),
  },
];

function runStaticCheckov(hcl) {
  const findings = [];
  for (const rule of STATIC_RULES) {
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
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');

  const dockerCmd = [
    'docker run --rm',
    '--network=none --memory=256m --cpus=0.5 --pids-limit=20',
    '--user=1000:1000',
    `-v "${workDir}":/workspace:ro`,
    CHECKOV_IMAGE,
    'checkov', '--directory', '/workspace', '--output', 'json', '--quiet',
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
