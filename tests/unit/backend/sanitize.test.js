/**
 * tests/unit/backend/sanitize.test.js
 *
 * Pure unit tests for backend/utils/sanitize.js.
 * No DB, no network — 100% synchronous logic.
 */
'use strict';

const path = require('path');
// Point straight at the source so these tests run without booting the server
const {
  detectSecrets,
  lintNetworkRules,
  stripHtml,
  hasMarkup,
} = require(path.join(__dirname, '../../../backend/utils/sanitize'));

// ─── detectSecrets ────────────────────────────────────────────────────────────
describe('detectSecrets()', () => {
  test('returns [] for clean HCL with no secrets', () => {
    const hcl = `
      resource "aws_s3_bucket" "example" {
        bucket = "my-bucket"
        tags   = { Environment = "dev" }
      }
    `;
    expect(detectSecrets(hcl)).toHaveLength(0);
  });

  test('detects AWS Access Key ID (AKIA...)', () => {
    const hcl = 'access_key = "AKIAIOSFODNN7EXAMPLE"';
    const findings = detectSecrets(hcl);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].name).toMatch(/AWS Access Key ID/i);
  });

  test('detects AWS Secret Access Key pattern', () => {
    const hcl = 'secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const findings = detectSecrets(hcl);
    expect(findings.some(f => f.name.includes('Secret Access Key'))).toBe(true);
  });

  test('detects GitHub personal access token', () => {
    const hcl = 'token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"';
    const findings = detectSecrets(hcl);
    expect(findings.some(f => f.name.includes('GitHub'))).toBe(true);
  });

  test('detects private key material', () => {
    const hcl = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...';
    const findings = detectSecrets(hcl);
    expect(findings.some(f => f.name.includes('Private Key'))).toBe(true);
  });

  test('detects generic hard-coded password', () => {
    const hcl = 'password = "SuperSecret99"';
    expect(detectSecrets(hcl).length).toBeGreaterThan(0);
  });

  test('does NOT flag Terraform variable references (${var.xxx})', () => {
    const hcl = 'password = "${var.db_password}"';
    expect(detectSecrets(hcl)).toHaveLength(0);
  });

  test('returns [] for null/undefined input', () => {
    expect(detectSecrets(null)).toHaveLength(0);
    expect(detectSecrets(undefined)).toHaveLength(0);
    expect(detectSecrets('')).toHaveLength(0);
  });
});

// ─── lintNetworkRules ─────────────────────────────────────────────────────────
describe('lintNetworkRules()', () => {
  test('returns [] for HCL with no open-world CIDRs', () => {
    const hcl = `
      resource "aws_security_group" "safe" {
        ingress { from_port = 443 to_port = 443 cidr_blocks = ["10.0.0.0/8"] }
      }
    `;
    expect(lintNetworkRules(hcl)).toHaveLength(0);
  });

  test('flags SSH (22) exposed to 0.0.0.0/0', () => {
    const hcl = `
      resource "aws_security_group" "bad" {
        ingress { from_port = 22 to_port = 22 cidr_blocks = ["0.0.0.0/0"] }
      }
    `;
    const warnings = lintNetworkRules(hcl);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => /SSH|22/i.test(w))).toBe(true);
  });

  test('flags RDP (3389) exposed to 0.0.0.0/0', () => {
    const hcl = `
      resource "aws_security_group" "rdp" {
        ingress { from_port = 3389 to_port = 3389 cidr_blocks = ["0.0.0.0/0"] }
      }
    `;
    const warnings = lintNetworkRules(hcl);
    expect(warnings.some(w => /RDP|3389/i.test(w))).toBe(true);
  });

  test('flags Postgres (5432) exposed to 0.0.0.0/0', () => {
    const hcl = `
      ingress { from_port = 5432 to_port = 5432 cidr_blocks = ["0.0.0.0/0"] }
    `;
    const warnings = lintNetworkRules(hcl);
    expect(warnings.some(w => /5432|Postgres/i.test(w))).toBe(true);
  });

  test('does NOT flag restricted CIDR even on privileged port', () => {
    const hcl = `
      ingress { from_port = 22 to_port = 22 cidr_blocks = ["10.0.1.0/24"] }
    `;
    expect(lintNetworkRules(hcl)).toHaveLength(0);
  });

  test('returns [] for null input', () => {
    expect(lintNetworkRules(null)).toHaveLength(0);
    expect(lintNetworkRules('')).toHaveLength(0);
  });
});

// ─── stripHtml ────────────────────────────────────────────────────────────────
describe('stripHtml()', () => {
  test('removes HTML tags from HCL', () => {
    const input  = '<script>alert(1)</script>resource "aws_s3_bucket" "b" {}';
    const output = stripHtml(input);
    expect(output).not.toMatch(/<script>/i);
    expect(output).toMatch(/aws_s3_bucket/);
  });

  test('removes inline style declarations', () => {
    const input  = 'color: red; resource "aws_instance" "i" {}';
    const output = stripHtml(input);
    expect(output).not.toMatch(/color:\s*red/i);
  });

  test('returns the string unchanged when no HTML is present', () => {
    const hcl = 'resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }';
    expect(stripHtml(hcl)).toBe(hcl);
  });

  test('handles null/undefined safely', () => {
    expect(() => stripHtml(null)).not.toThrow();
    expect(() => stripHtml(undefined)).not.toThrow();
  });
});

// ─── hasMarkup ────────────────────────────────────────────────────────────────
describe('hasMarkup()', () => {
  test('returns true when <script> tags are present', () => {
    expect(hasMarkup('<script>alert(1)</script>')).toBe(true);
  });

  test('returns false for plain HCL', () => {
    expect(hasMarkup('resource "aws_s3_bucket" "x" {}')).toBe(false);
  });
});
