/**
 * tests/unit/backend/code-review.test.js
 */
'use strict';
const path = require('path');
const cr = require(path.join(__dirname, '../../../backend/services/codeReview'));

const RDS = 'resource "aws_db_instance" "db" {\n  publicly_accessible = true\n  password = "hunter2"\n}\n';

describe('reviewFiles', () => {
  test('verdict is request_changes when a critical or high finding exists', () => {
    const r = cr.reviewFiles([{ path: 'main.tf', content: RDS }]);
    expect(r.verdict).toBe('request_changes');
    expect(r.counts.critical).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.path === 'main.tf')).toBe(true);
  });

  test('verdict is comment for medium-only findings and approve for clean code', () => {
    const medium = cr.reviewFiles([{ path: 'm.tf', content: 'resource "aws_instance" "web" {\n  ami = "ami-1"\n}\n' }]);
    expect(medium.verdict).toBe('comment');
    expect(medium.counts.high + medium.counts.critical).toBe(0);
    const clean = cr.reviewFiles([{ path: 'v.tf', content: 'terraform {\n  required_version = ">= 1.6"\n}\nresource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n' }]);
    expect(clean.verdict).toBe('approve');
    expect(clean.findings).toEqual([]);
  });

  test('cross-file companion resources in the same directory are seen', () => {
    const files = [
      { path: 'infra/main.tf', content: 'resource "aws_s3_bucket" "logs" {\n  bucket = "l"\n}\n' },
      { path: 'infra/versioning.tf', content: 'resource "aws_s3_bucket_versioning" "logs" {\n  bucket = aws_s3_bucket.logs.id\n  versioning_configuration { status = "Enabled" }\n}\n' },
    ];
    const r = cr.reviewFiles(files);
    expect(r.findings.map((f) => f.id)).not.toContain('CKV_AWS_21');
  });

  test('line numbers are mapped back to the right file', () => {
    const files = [
      { path: 'a/one.tf', content: 'variable "x" {\n  description = "d"\n  type = string\n}\n' },
      { path: 'a/two.tf', content: '\n\nresource "aws_db_instance" "db" {\n  publicly_accessible = true\n}\n' },
    ];
    const f = cr.reviewFiles(files).findings.find((x) => x.id === 'CKV_AWS_17');
    expect(f.path).toBe('a/two.tf');
    expect(f.line).toBe(3);
  });

  test('changedPaths restricts reporting but still reads the whole directory', () => {
    const files = [
      { path: 'm/main.tf', content: 'resource "aws_db_instance" "db" {\n  publicly_accessible = true\n}\n' },
      { path: 'm/extra.tf', content: 'resource "aws_s3_bucket" "x" {\n  bucket = "x"\n}\n' },
    ];
    const r = cr.reviewFiles(files, { changedPaths: ['m/extra.tf'] });
    expect(r.findings.every((f) => f.path === 'm/extra.tf')).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  test('module-level issues without a file location are excluded from findings', () => {
    const r = cr.reviewFiles([{ path: 'x/main.tf', content: 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n' }]);
    expect(r.findings.some((f) => f.id === 'TERRAFORM_VERSION_MISSING')).toBe(false);
  });
});

describe('applyAutofixes', () => {
  test('sets literal attributes and re-review clears the fixed findings', () => {
    const files = [{ path: 'main.tf', content: RDS }];
    const report = cr.reviewFiles(files);
    const fix = cr.applyAutofixes(files, report);
    expect(fix.applied.map((a) => `${a.attribute}=${a.value}`)).toEqual(
      expect.arrayContaining(['storage_encrypted=true', 'publicly_accessible=false']));
    const after = fix.files.find((f) => f.path === 'main.tf').after;
    expect(after).toMatch(/publicly_accessible = false/);
    expect(after).toMatch(/storage_encrypted = true/);
    const again = cr.reviewFiles([{ path: 'main.tf', content: after }]);
    expect(again.findings.map((f) => f.id)).not.toEqual(expect.arrayContaining(['CKV_AWS_16', 'CKV_AWS_17']));
  });

  test('never overwrites an expression: var-driven settings are skipped and reported', () => {
    const files = [{ path: 'k.tf', content: 'resource "aws_kms_key" "k" {\n  enable_key_rotation = var.rotate\n}\n' }];
    const fix = cr.applyAutofixes(files, cr.reviewFiles(files));
    expect(fix.files).toEqual([]);
    expect(fix.skipped).toEqual([expect.objectContaining({ id: 'CKV_AWS_7', reason: expect.stringMatching(/expression/) })]);
  });

  test('fixes are idempotent: a second pass changes nothing', () => {
    const files = [{ path: 'main.tf', content: RDS }];
    const first = cr.applyAutofixes(files, cr.reviewFiles(files));
    const second = cr.applyAutofixes([{ path: 'main.tf', content: first.files[0].after }],
      cr.reviewFiles([{ path: 'main.tf', content: first.files[0].after }]));
    expect(second.applied).toEqual([]);
    expect(second.files).toEqual([]);
  });

  test('multiple fixes in one file do not corrupt offsets', () => {
    const src = 'resource "aws_db_instance" "a" {\n  publicly_accessible = true\n}\nresource "aws_kms_key" "k" {\n  description = "k"\n}\n';
    const files = [{ path: 'm.tf', content: src }];
    const fix = cr.applyAutofixes(files, cr.reviewFiles(files));
    const after = fix.files[0].after;
    expect(after).toMatch(/resource "aws_db_instance" "a" \{\n  storage_encrypted = true\n  publicly_accessible = false\n\}/);
    expect(after).toMatch(/resource "aws_kms_key" "k" \{\n  enable_key_rotation = true\n  description = "k"\n\}/);
  });
});

describe('pull request mapping', () => {
  const patch = '@@ -1,3 +10,5 @@\n context\n-removed\n+added one\n+added two\n context2\n';

  test('commentableLines returns new-file line numbers for added and context lines only', () => {
    const lines = cr.commentableLines(patch);
    expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect(cr.commentableLines(null).size).toBe(0);
  });

  test('findings on diff lines become inline comments; others go to the review body', () => {
    const report = cr.reviewFiles([{ path: 'main.tf', content: RDS }]);
    const onDiff = report.findings.find((f) => f.id === 'TFGEN_HARDCODED_CREDENTIAL'); // line 3
    // Only line 1 is part of the diff; the credential finding is on line 3.
    const payload = cr.buildPullRequestReview(report, new Map([['main.tf', '@@ -0,0 +1,1 @@\n+publicly_accessible = true\n']]));
    expect(payload.comments.every((c) => c.line === 1 && c.side === 'RIGHT')).toBe(true);
    expect(payload.comments.length).toBeGreaterThan(0);
    expect(payload.unplaced.some((u) => u.id === 'TFGEN_HARDCODED_CREDENTIAL' && u.line === onDiff.line)).toBe(true);
    expect(payload.unplaced.length).toBeGreaterThan(0);
    expect(payload.body).toMatch(/outside this diff/);
  });

  test('event is REQUEST_CHANGES for blocking verdicts and COMMENT otherwise; approve is never posted as an approval', () => {
    const blocking = cr.buildPullRequestReview(cr.reviewFiles([{ path: 'a.tf', content: RDS }]), new Map());
    expect(blocking.event).toBe('REQUEST_CHANGES');
    const clean = cr.buildPullRequestReview(cr.reviewFiles([{ path: 'a.tf', content: 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n' }]), new Map());
    expect(clean.event).toBe('COMMENT');
  });
});

describe('toMarkdownReport', () => {
  test('renders a table and a clean message when there are no findings', () => {
    expect(cr.toMarkdownReport(cr.reviewFiles([{ path: 'a.tf', content: 'terraform {\n  required_version = ">= 1.6"\n}\n' }]))).toMatch(/No findings/);
    const md = cr.toMarkdownReport(cr.reviewFiles([{ path: 'a.tf', content: RDS }]));
    expect(md).toMatch(/\| critical \| `TFGEN_HARDCODED_CREDENTIAL` \| `a\.tf:3` \|/);
  });
});
