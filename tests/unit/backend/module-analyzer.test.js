/**
 * tests/unit/backend/module-analyzer.test.js
 */
'use strict';
const path = require('path');
const { analyzeModule, extractReferences, findCycles, toMarkdown, toMermaid, isSecretName } = require(
  path.join(__dirname, '../../../backend/services/moduleAnalyzer')
);

const rules = (r) => r.issues.map((i) => i.rule);

describe('inventory', () => {
  test('lists variables, outputs, locals, resources, data, modules and providers', () => {
    const r = analyzeModule([{ path: 'main.tf', content: `
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
variable "name" {
  description = "Bucket name"
  type        = string
}
locals {
  common = { team = var.name }
}
data "aws_caller_identity" "me" {}
resource "aws_s3_bucket" "b" {
  bucket = "\${var.name}-\${data.aws_caller_identity.me.account_id}"
  tags   = local.common
}
output "bucket_id" {
  description = "Bucket id"
  value       = aws_s3_bucket.b.id
}
module "net" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.0"
  name    = var.name
}
` }]);
    expect(r.variables.map((v) => v.name)).toEqual(['name']);
    expect(r.outputs.map((o) => o.name)).toEqual(['bucket_id']);
    expect(r.locals.map((l) => l.name)).toEqual(['common']);
    expect(r.resources.map((x) => x.address)).toEqual(['aws_s3_bucket.b']);
    expect(r.dataSources.map((x) => x.address)).toEqual(['data.aws_caller_identity.me']);
    expect(r.moduleCalls[0]).toEqual(expect.objectContaining({ name: 'net', version: '5.1.0', inputs: ['name'] }));
    expect(r.terraform.requiredVersion).toBe('>= 1.6');
    expect(r.terraform.requiredProviders[0]).toEqual(expect.objectContaining({ name: 'aws', version: '~> 5.0' }));
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('a clean module produces no errors and no warnings beyond the advisory terraform block', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'terraform {\n  required_version = ">= 1.6"\n}\nvariable "x" {\n  description = "d"\n  type = string\n}\nresource "aws_s3_bucket" "b" {\n  bucket = var.x\n}\n' }]);
    expect(r.summary.issues.error).toBe(0);
    expect(r.summary.issues.warning).toBe(0);
  });
});

describe('reference and configuration checks', () => {
  test('undeclared var / resource / module / data references are errors with locations', () => {
    const r = analyzeModule([{ path: 'main.tf', content: `
resource "aws_iam_role" "r" {
  path = var.nope
  name = aws_s3_bucket.missing.arn
  x    = module.ghost.out
  y    = data.aws_iam_policy_document.gone.json
}
` }]);
    const errs = r.issues.filter((i) => i.severity === 'error').map((i) => i.rule).sort();
    expect(errs).toEqual(['DATA_UNDECLARED', 'MODULE_UNDECLARED', 'RESOURCE_UNDECLARED', 'VAR_UNDECLARED']);
    expect(r.issues.find((i) => i.rule === 'VAR_UNDECLARED')).toEqual(expect.objectContaining({ file: 'main.tf', line: 3 }));
  });

  test('a reference inside a comment is not a dependency', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'variable "x" {\n  description = "d"\n  type = string\n}\nresource "aws_s3_bucket" "b" {\n  # bucket = var.x\n  bucket = "static"\n}\n' }]);
    expect(rules(r)).toContain('VAR_UNUSED');
    expect(rules(r)).not.toContain('VAR_UNDECLARED');
  });

  test('unused variables and locals are reported', () => {
    const r = analyzeModule([{ path: 'v.tf', content: 'variable "unused" {\n  description = "d"\n  type = string\n}\nlocals {\n  dead = 1\n}\n' }]);
    expect(rules(r)).toEqual(expect.arrayContaining(['VAR_UNUSED', 'LOCAL_UNUSED']));
  });

  test('missing description and type are warnings', () => {
    const r = analyzeModule([{ path: 'v.tf', content: 'variable "x" {\n  default = 1\n}\nresource "aws_s3_bucket" "b" {\n  bucket = var.x\n}\n' }]);
    expect(rules(r)).toEqual(expect.arrayContaining(['VAR_NO_DESCRIPTION', 'VAR_NO_TYPE']));
  });
});

describe('secrets and sensitivity', () => {
  test('secret-named variable with a literal default is a critical-grade error', () => {
    const r = analyzeModule([{ path: 'v.tf', content: 'variable "db_password" {\n  description = "d"\n  type = string\n  default = "hunter2"\n}\nresource "aws_db_instance" "d" {\n  password = var.db_password\n}\n' }]);
    expect(r.issues.find((i) => i.rule === 'VAR_SECRET_DEFAULT')).toEqual(expect.objectContaining({ severity: 'error', line: 4 }));
    expect(rules(r)).toContain('VAR_SECRET_NOT_SENSITIVE');
  });

  test('an output that exposes a sensitive variable without sensitive = true is an error', () => {
    const r = analyzeModule([{ path: 'v.tf', content: 'variable "s" {\n  description = "d"\n  type = string\n  sensitive = true\n}\noutput "pw" {\n  description = "d"\n  value = var.s\n}\n' }]);
    expect(rules(r)).toContain('OUTPUT_SENSITIVE_LEAK');
    const fixed = analyzeModule([{ path: 'v.tf', content: 'variable "s" {\n  description = "d"\n  type = string\n  sensitive = true\n}\noutput "pw" {\n  description = "d"\n  value = var.s\n  sensitive = true\n}\n' }]);
    expect(rules(fixed)).not.toContain('OUTPUT_SENSITIVE_LEAK');
  });

  test('a literal credential passed into a module is an error', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'module "db" {\n  source = "./modules/db"\n  password = "plain"\n}\n' }]);
    expect(rules(r)).toContain('MODULE_INPUT_HARDCODED_SECRET');
  });

  test('isSecretName matches credentials but not identifiers such as access_key_id', () => {
    expect(isSecretName('db_password')).toBe(true);
    expect(isSecretName('api_key')).toBe(true);
    expect(isSecretName('access_key_id')).toBe(false);
    expect(isSecretName('secret_arn')).toBe(false);
    expect(isSecretName('instance_type')).toBe(false);
  });
});

describe('dependency graph', () => {
  test('edges point from the referencing block to the referenced one', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\nresource "aws_s3_bucket_policy" "p" {\n  bucket = aws_s3_bucket.a.id\n}\n' }]);
    expect(r.graph.edges).toEqual([{ from: 'resource.aws_s3_bucket_policy.p', to: 'resource.aws_s3_bucket.a', kind: 'reference' }]);
  });

  test('a circular dependency through a local is reported as an error with the cycle path', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n  tags = local.t\n}\nlocals {\n  t = { id = aws_s3_bucket.b.id }\n}\n' }]);
    const cycle = r.issues.find((i) => i.rule === 'DEPENDENCY_CYCLE');
    expect(cycle.severity).toBe('error');
    expect(cycle.message).toMatch(/resource\.aws_s3_bucket\.b/);
    expect(cycle.message).toMatch(/local\.t/);
  });

  test('findCycles finds each cycle once and ignores acyclic graphs', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['a']]]))).toHaveLength(1);
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']]]))).toEqual([]);
  });

  test('extractReferences recognises provider resource types and ignores each/count/self', () => {
    const refs = extractReferences('x = aws_s3_bucket.a.id\ny = each.value\nz = count.index\nw = self.name', ['aws']);
    expect(refs).toEqual(['resource.aws_s3_bucket.a']);
  });
});

describe('module sources and provider pins', () => {
  test('registry source without version and git source without ref are warned', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'module "a" {\n  source = "terraform-aws-modules/vpc/aws"\n}\nmodule "b" {\n  source = "git::https://example.com/x.git"\n}\nmodule "c" {\n  source = "./local"\n}\n' }]);
    const warns = r.issues.filter((i) => i.rule === 'MODULE_SOURCE_UNPINNED');
    expect(warns.map((w) => w.subject)).toEqual(['module.a', 'module.b']);
  });

  test('provider without version and missing required_version are reported', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n' }]);
    expect(rules(r)).toEqual(expect.arrayContaining(['PROVIDER_VERSION_UNPINNED', 'TERRAFORM_VERSION_MISSING']));
  });
});

describe('documentation output', () => {
  test('toMarkdown renders inputs and outputs tables', () => {
    const r = analyzeModule([{ path: 'v.tf', content: 'variable "name" {\n  description = "Bucket | name"\n  type = string\n}\noutput "id" {\n  description = "The id"\n  value = "x"\n}\n' }]);
    const md = toMarkdown(r, { title: 'Demo' });
    expect(md).toMatch(/^# Demo/);
    expect(md).toContain('| `name` | string | yes | no | Bucket \\| name |');
    expect(md).toContain('| `id` | no | The id |');
  });

  test('toMermaid emits one node per graph node and one arrow per edge', () => {
    const r = analyzeModule([{ path: 'main.tf', content: 'variable "x" {\n  description = "d"\n  type = string\n}\nresource "aws_s3_bucket" "b" {\n  bucket = var.x\n}\n' }]);
    const mm = toMermaid(r);
    expect(mm.startsWith('flowchart LR')).toBe(true);
    expect(mm).toContain('resource_aws_s3_bucket_b --> var_x'); // A depends on B
  });
});
