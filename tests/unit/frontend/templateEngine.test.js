/**
 * tests/unit/frontend/templateEngine.test.js
 *
 * Validation fix regression tests for templateEngine.js.
 * Now a Jest suite (it was a standalone script whose process.exit() aborted
 * the whole Jest run). The ES-module engine is loaded via tests/babel.config.js.
 *
 * Run: npx jest --config jest.unit.config.js unit/frontend/templateEngine
 */
'use strict';

const path = require('path');
const assert = require('assert').strict;

const MODULE_PATH = path.resolve(
  __dirname, '../../../frontend/src/engine/templateEngine.js'
);

// ── helpers ───────────────────────────────────────────────────────────────────
function mk_expect(val) {
  return {
    toBe:           (e)  => assert.strictEqual(val, e),
    toBeDefined:    ()   => assert.notStrictEqual(val, undefined),
    toBeUndefined:  ()   => assert.strictEqual(val, undefined),
    toHaveLength:   (e)  => { assert.ok((val||[]).length === e, `Expected length ${e} got ${(val||[]).length}`); },
    toContain:      (e)  => { assert.ok(String(val).includes(e), `Expected to contain "${e}" in: ${String(val).slice(0,200)}`); },
    toHaveProperty: (k)  => { assert.ok(Object.prototype.hasOwnProperty.call(val, k), `Expected property "${k}"`); },
    toMatch:        (re) => {
      const ok = typeof re === 'string' ? String(val).includes(re) : re.test(String(val));
      assert.ok(ok, `Expected to match ${re}: ${String(val).slice(0,200)}`);
    },
    not: {
      toContain:      (e)  => { assert.ok(!String(val).includes(e),      `Expected NOT to contain "${e}"`); },
      toHaveProperty: (k)  => { assert.ok(!Object.prototype.hasOwnProperty.call(val, k), `Expected NOT to have property "${k}"`); },
      toMatch:        (re) => {
        const ok = typeof re === 'string' ? String(val).includes(re) : re.test(String(val));
        assert.ok(!ok, `Expected NOT to match ${re}: ${String(val).slice(0,200)}`);
      },
    },
  };
}

// ── test data ─────────────────────────────────────────────────────────────────
const MOCK_RESOURCES = [{
  _id: '1', service_type: 'vpc', label: 'my_vpc',
  hcl_output: 'resource "aws_vpc" "my_vpc" {\n  cidr_block = "10.0.0.0/16"\n}',
  config: { name: 'my_vpc', cidr_block: '10.0.0.0/16' },
}];

const RDS_RESOURCE = {
  _id: '2', service_type: 'rds', label: 'my_rds',
  hcl_output: 'resource "aws_db_instance" "my_rds" {\n  password = var.db_password\n  username = var.db_user\n}',
  config: { name: 'my_rds' },
};

describe('templateEngine (frontend/src/engine)', () => {
  const e = require(MODULE_PATH);

  function run(name, fn) {
    test(name, () => fn(e));
  }

  // ─── generateHCL ──────────────────────────────────────────────────────────

  run('BUG-TF-02: undefined placeholder → empty string, not {{token}}', ({ generateHCL }) => {
    const tpl = 'resource "aws_subnet" "{{name}}" {\n  vpc_id = {{vpc_id}}\n  cidr = "10.0.1.0/24"\n}';
    const out = generateHCL(tpl, { name: 'my_subnet' });
    mk_expect(out).not.toMatch(/\{\{vpc_id\}\}/);
    mk_expect(out).not.toMatch(/\{\{[^}]+\}\}/);
  });

  run('BUG-TF-02: lines with empty value are stripped', ({ generateHCL }) => {
    const tpl = 'resource "aws_subnet" "{{name}}" {\n  vpc_id = {{vpc_id}}\n  cidr = "{{cidr}}"\n}';
    const out = generateHCL(tpl, { name: 'my_subnet', cidr: '10.0.0.0/24' });
    mk_expect(out).not.toMatch(/vpc_id\s*=/);
  });

  run('retains defined values', ({ generateHCL }) => {
    const tpl = 'resource "aws_s3_bucket" "{{name}}" {\n  bucket = "{{bucket_name}}"\n}';
    const out = generateHCL(tpl, { name: 'my_bucket', bucket_name: 'my-bucket-123' });
    mk_expect(out).toContain('resource "aws_s3_bucket" "my_bucket"');
    mk_expect(out).toContain('bucket = "my-bucket-123"');
  });

  // ─── generateProviderBlock ────────────────────────────────────────────────

  run('BUG-TF-01: no terraform{} wrapper block', ({ generateProviderBlock }) => {
    const block = generateProviderBlock('ap-south-1');
    mk_expect(block).not.toMatch(/terraform\s*\{/);
  });

  run('BUG-TF-01: no required_providers', ({ generateProviderBlock }) => {
    const block = generateProviderBlock('ap-south-1');
    mk_expect(block).not.toMatch('required_providers');
  });

  run('emits provider "aws" with correct region', ({ generateProviderBlock }) => {
    const block = generateProviderBlock('eu-west-1');
    mk_expect(block).toContain('provider "aws"');
    mk_expect(block).toContain('region = "eu-west-1"');
  });

  // ─── generateTerraformBlock ───────────────────────────────────────────────

  run('without backend: single terraform{} with required_version + required_providers', ({ generateTerraformBlock }) => {
    const block = generateTerraformBlock(null);
    const count = (block.match(/terraform\s*\{/g) || []).length;
    mk_expect(count).toBe(1);
    mk_expect(block).toContain('required_version');
    mk_expect(block).toContain('required_providers');
    mk_expect(block).not.toMatch(/backend/);
  });

  run('BUG-TF-04: with backend — backend inside the SAME terraform{} block (not separate)', ({ generateTerraformBlock }) => {
    const block = generateTerraformBlock({ type: 's3', bucket: 'tfstate', region: 'us-east-1' });
    const count = (block.match(/terraform\s*\{/g) || []).length;
    mk_expect(count).toBe(1);
    mk_expect(block).toContain('required_providers');
    mk_expect(block).toContain('backend "s3"');
  });

  // ─── extractImplicitVariables ─────────────────────────────────────────────

  run('BUG-TF-03: detects var.db_password reference', ({ extractImplicitVariables }) => {
    const hcl = 'resource "aws_db_instance" "rds" {\n  password = var.db_password\n}';
    const implicit = extractImplicitVariables(hcl, {});
    mk_expect(implicit).toHaveProperty('db_password');
  });

  run('BUG-TF-03: password var is marked sensitive', ({ extractImplicitVariables }) => {
    const hcl = 'password = var.db_password';
    const implicit = extractImplicitVariables(hcl, {});
    mk_expect(implicit.db_password.sensitive).toBe(true);
  });

  run('does not re-declare variables in explicit map', ({ extractImplicitVariables }) => {
    const hcl = 'ami = var.ec2_ami_id';
    const explicit = { ec2_ami_id: { type: 'string' } };
    const implicit = extractImplicitVariables(hcl, explicit);
    mk_expect(implicit).not.toHaveProperty('ec2_ami_id');
  });

  run('handles multiple distinct var.XXX references', ({ extractImplicitVariables }) => {
    const hcl = 'pass = var.db_password\nuser = var.db_user\nhost = var.db_host';
    const implicit = extractImplicitVariables(hcl, {});
    mk_expect(Object.keys(implicit).length).toBe(3);
  });

  // ─── buildSplitHCL ───────────────────────────────────────────────────────

  run('providers.tf has NO required_providers', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(f['providers.tf']).toBeDefined();
    mk_expect(f['providers.tf']).not.toMatch('required_providers');
  });

  run('providers.tf has NO terraform{} block', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(f['providers.tf']).not.toMatch(/terraform\s*\{/);
  });

  run('versions.tf is the single file with required_providers', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(f['versions.tf']).toContain('required_providers');
  });

  run('required_providers appears exactly ONCE across ALL files (no duplicate)', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    const combined = Object.values(f).join('\n---\n');
    const count = (combined.match(/required_providers/g) || []).length;
    mk_expect(count).toBe(1);
  });

  run('backend.tf absent when no backend configured', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(f['backend.tf']).toBeUndefined();
  });

  run('backend.tf present and correct when backend IS configured', ({ buildSplitHCL }) => {
    const f = buildSplitHCL(
      MOCK_RESOURCES, 'ap-south-1', 'dev',
      { type: 's3', bucket: 'my-tfstate' }, {}, {}, 'test'
    );
    mk_expect(f['backend.tf']).toBeDefined();
    mk_expect(f['backend.tf']).toContain('backend "s3"');
  });

  run('BUG-TF-03: var.db_password auto-declared as sensitive in variables.tf', ({ buildSplitHCL }) => {
    const f = buildSplitHCL([RDS_RESOURCE], 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(f['variables.tf']).toBeDefined();
    mk_expect(f['variables.tf']).toContain('variable "db_password"');
    mk_expect(f['variables.tf']).toContain('sensitive   = true');
  });

  // ─── buildFullHCL ────────────────────────────────────────────────────────

  run('BUG-TF-04: with backend → exactly ONE terraform{} block', ({ buildFullHCL }) => {
    const hcl = buildFullHCL(
      MOCK_RESOURCES, 'ap-south-1', 'dev',
      { type: 's3', bucket: 'my-state' }, {}, {}, 'test'
    );
    const count = (hcl.match(/terraform\s*\{/g) || []).length;
    mk_expect(count).toBe(1);
  });

  run('with backend → both backend key and required_providers present', ({ buildFullHCL }) => {
    const hcl = buildFullHCL(
      MOCK_RESOURCES, 'ap-south-1', 'dev',
      { type: 's3', bucket: 'my-state' }, {}, {}, 'test'
    );
    mk_expect(hcl).toContain('backend "s3"');
    mk_expect(hcl).toContain('required_providers');
  });

  run('without backend → single terraform{} still present', ({ buildFullHCL }) => {
    const hcl = buildFullHCL(MOCK_RESOURCES, 'ap-south-1', 'dev', {}, {}, {}, 'test');
    const count = (hcl.match(/terraform\s*\{/g) || []).length;
    mk_expect(count).toBe(1);
  });

  run('BUG-TF-03: var.db_password auto-declared in combined output', ({ buildFullHCL }) => {
    const hcl = buildFullHCL([RDS_RESOURCE], 'ap-south-1', 'dev', {}, {}, {}, 'test');
    mk_expect(hcl).toContain('variable "db_password"');
  });

});
