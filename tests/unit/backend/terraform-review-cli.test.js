/**
 * tests/unit/backend/terraform-review-cli.test.js
 * The CI gate: the CLI must fail on insecure Terraform and pass on clean code.
 */
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const CLI = path.join(ROOT, 'scripts/terraform-review.js');
const FIXTURES = path.join(ROOT, 'tests/fixtures/terraform-review');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
}

describe('scripts/terraform-review.js (CI gate)', () => {
  test('exits 0 for clean Terraform', () => {
    const r = run([path.join(FIXTURES, 'clean')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 finding\(s\) at or above high/);
  });

  test('exits 1 for insecure Terraform and names the problems', () => {
    const r = run([path.join(FIXTURES, 'insecure')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/TFGEN_HARDCODED_CREDENTIAL/);
    expect(r.stdout).toMatch(/CKV_AWS_24|CKV_AWS_25/);
  });

  test('--fail-on critical ignores high-severity findings', () => {
    const r = run([path.join(FIXTURES, 'insecure'), '--fail-on', 'critical']);
    expect(r.status).toBe(1); // a hard-coded credential is critical, so still fails
    const onlyHigh = run([path.join(FIXTURES, 'clean'), '--fail-on', 'critical']);
    expect(onlyHigh.status).toBe(0);
  });

  test('usage errors exit 2', () => {
    expect(run([]).status).toBe(2);
    expect(run([path.join(FIXTURES, 'clean'), '--fail-on', 'extreme']).status).toBe(2);
    expect(run(['/no/such/dir/here']).status).toBe(2);
  });

  test('--markdown writes the summary to a file', () => {
    const os = require('os'); const fs = require('fs');
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tfr-')), 'review.md');
    run([path.join(FIXTURES, 'insecure'), '--markdown', out]);
    expect(fs.readFileSync(out, 'utf8')).toMatch(/Terraform review/);
  });
});
