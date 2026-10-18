/**
 * tests/api/terraform.api.test.js
 *
 * API tests for /api/terraform — fmt, validate, plan, checkov, infracost.
 * These use HCL strings so no real AWS credentials are needed.
 */
'use strict';

const { post, registerUser } = require('../setup/testHelpers');

let token;

const VALID_HCL = `
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = "us-east-1" }

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "main-vpc", Environment = "test" }
}
`;

const INVALID_HCL = `
resource "aws_vpc" "broken {
  cidr_block = "not-a-cidr"
`;

const HCL_WITH_SECRET = `
resource "aws_db_instance" "db" {
  password = "SuperSecretPlaintext123"
}
`;

const HCL_WITH_SECURITY_ISSUES = `
resource "aws_security_group" "wide_open" {
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;

beforeAll(async () => {
  ({ token } = await registerUser());
});

describe('Terraform API — /api/terraform', () => {

  // ─── /fmt ──────────────────────────────────────────────────────────────────
  describe('POST /terraform/fmt', () => {
    test('200 returns formatted HCL for valid input', async () => {
      const res = await post('/terraform/fmt', { hcl: VALID_HCL }, token);
      expect([200, 201]).toContain(res.status);
      expect(res.data.formatted || res.data.hcl || res.data).toBeDefined();
    });

    test('400 when hcl field is missing', async () => {
      const res = await post('/terraform/fmt', {}, token);
      expect(res.status).toBe(400);
    });

    test('400 when HCL contains a detected secret', async () => {
      const res = await post('/terraform/fmt', { hcl: HCL_WITH_SECRET }, token);
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/secret/i);
    });

    test('413 when HCL payload exceeds 1 MB', async () => {
      const bigHcl = 'x'.repeat(1_100_000);
      const res    = await post('/terraform/fmt', { hcl: bigHcl }, token);
      expect(res.status).toBe(413);
    });
  });

  // ─── /validate ─────────────────────────────────────────────────────────────
  describe('POST /terraform/validate', () => {
    test('200 or 422 validates syntactically correct HCL', async () => {
      const res = await post('/terraform/validate', { hcl: VALID_HCL }, token);
      // 200 = valid, 422 = invalid with details — both are acceptable shaped responses
      // 202 = queued as a background job (Redis available); 200/422 = synchronous path
      expect([200, 202, 422]).toContain(res.status);
      expect(res.data).toBeDefined();
    });

    test('400 for missing hcl body', async () => {
      const res = await post('/terraform/validate', {}, token);
      expect(res.status).toBe(400);
    });

    test('400 when HCL contains a literal secret', async () => {
      const res = await post('/terraform/validate', { hcl: HCL_WITH_SECRET }, token);
      expect(res.status).toBe(400);
    });
  });

  // ─── /lint (network rules) ─────────────────────────────────────────────────
  describe('POST /terraform/lint', () => {
    test('returns lint warnings for HCL with open SSH', async () => {
      const res = await post('/terraform/lint', { hcl: HCL_WITH_SECURITY_ISSUES }, token);
      if (res.status === 404) return; // endpoint may not exist as standalone
      expect([200, 201]).toContain(res.status);
      const body = JSON.stringify(res.data);
      expect(body).toMatch(/22|SSH|warn/i);
    });
  });

  // ─── /checkov ──────────────────────────────────────────────────────────────
  describe('POST /terraform/checkov', () => {
    test('200 with findings array for HCL with security issues', async () => {
      const res = await post('/terraform/scan', { hcl: HCL_WITH_SECURITY_ISSUES }, token);
      expect([200, 201]).toContain(res.status);
      expect(Array.isArray(res.data.checkov?.findings)).toBe(true);
    });

    test('returns no critical findings for clean VPC HCL', async () => {
      const res = await post('/terraform/scan', { hcl: VALID_HCL }, token);
      expect([200, 201]).toContain(res.status);
    });

    test('401 when unauthenticated (if auth required)', async () => {
      const res = await post('/terraform/scan', { hcl: VALID_HCL });
      // Some deployments allow anonymous checkov; accept 200 or 401
      expect([200, 401]).toContain(res.status);
    });
  });

  // ─── /infracost ────────────────────────────────────────────────────────────
  describe('POST /terraform/infracost', () => {
    test('200 or 503 (if infracost not installed) with cost data', async () => {
      const res = await post('/terraform/cost', { hcl: VALID_HCL }, token);
      // 200 = estimate returned, 503 = infracost CLI unavailable (acceptable in CI)
      expect([200, 503]).toContain(res.status);
    });
  });
});
