/**
 * tests/unit/backend/checkov-static.test.js
 *
 * Tests for the static (no-Docker) rule-based security linter embedded in
 * backend/services/checkov.js.  We exercise the exported `runCheckov` function
 * with mock HCL that contains known-bad patterns.
 */
'use strict';

const path = require('path');

// Stub out child_process so no real Docker calls happen
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, opts, cb) => {
    if (!cb) cb = opts;
    // Simulate Docker not available
    cb(new Error('Docker not found'), '', '');
  }),
}));

// Stub isDockerAvailable → always false so static rules run
// Jest hoists jest.mock() above require(), so the path must be a literal here
// (referencing the `path` variable threw "Cannot access 'path' before initialization").
jest.mock('../../../backend/utils/dockerAvailable', () => ({
  isDockerAvailable: jest.fn().mockResolvedValue(false),
}));

const { runCheckov } = require(path.join(__dirname, '../../../backend/services/checkov'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hclSgSsh() {
  return `
    resource "aws_security_group" "bad_sg" {
      name = "bad"
      ingress {
        from_port   = 22
        to_port     = 22
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }
    }
  `;
}

function hclSgRdp() {
  return `
    resource "aws_security_group" "rdp_sg" {
      ingress {
        from_port   = 3389
        to_port     = 3389
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
      }
    }
  `;
}

function hclS3NoEncryption() {
  return `
    resource "aws_s3_bucket" "no_enc" {
      bucket = "my-bucket"
    }
  `;
}

function hclS3WithEncryption() {
  return `
    resource "aws_s3_bucket" "enc_ok" {
      bucket = "secure-bucket"
      server_side_encryption_configuration {
        rule {
          apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
        }
      }
      versioning { enabled = true }
      logging { target_bucket = "log-bucket" }
    }
  `;
}

function hclClean() {
  return `
    resource "aws_vpc" "main" {
      cidr_block = "10.0.0.0/16"
      enable_dns_support = true
    }
  `;
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('runCheckov() static rule engine', () => {
  test('returns findings array in response', async () => {
    const result = await runCheckov(hclClean());
    expect(result).toHaveProperty('findings');
    expect(Array.isArray(result.findings)).toBe(true);
  });

  test('flags CKV_AWS_25: SSH port 22 open to 0.0.0.0/0', async () => {
    const result = await runCheckov(hclSgSsh());
    const ids = result.findings.map(f => f.check_id || f.id);
    expect(ids).toContain('CKV_AWS_25');
  });

  test('flags CKV_AWS_24: RDP port 3389 open to 0.0.0.0/0', async () => {
    const result = await runCheckov(hclSgRdp());
    const ids = result.findings.map(f => f.check_id || f.id);
    expect(ids).toContain('CKV_AWS_24');
  });

  test('flags CKV_AWS_19: S3 missing server-side encryption', async () => {
    const result = await runCheckov(hclS3NoEncryption());
    const ids = result.findings.map(f => f.check_id || f.id);
    expect(ids).toContain('CKV_AWS_19');
  });

  test('flags CKV_AWS_21: S3 missing versioning', async () => {
    const result = await runCheckov(hclS3NoEncryption());
    const ids = result.findings.map(f => f.check_id || f.id);
    expect(ids).toContain('CKV_AWS_21');
  });

  test('no critical findings for fully-compliant S3 bucket', async () => {
    const result = await runCheckov(hclS3WithEncryption());
    const critical = result.findings.filter(f =>
      ['CKV_AWS_18', 'CKV_AWS_19', 'CKV_AWS_21'].includes(f.check_id || f.id)
    );
    expect(critical).toHaveLength(0);
  });

  test('returns empty findings for plain VPC resource with no rules', async () => {
    const result = await runCheckov(hclClean());
    expect(result.findings).toHaveLength(0);
  });

  test('each finding has id, severity and message fields', async () => {
    const result = await runCheckov(hclSgSsh());
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.check_id || f.id).toBeDefined();
      expect(f.severity).toBeDefined();
      expect(f.message || f.check_id).toBeDefined();
    }
  });
});
