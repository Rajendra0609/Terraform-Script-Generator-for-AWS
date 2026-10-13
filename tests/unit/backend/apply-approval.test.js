/**
 * tests/unit/backend/apply-approval.test.js
 * The apply approval gate, with the database replaced by a fake.
 */
'use strict';
process.env.JWT_SECRET = 'unit-test-jwt-secret-padded-to-32-chars-minimum';
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret-padded-to-32-chars-min';
process.env.ENCRYPT_KEY = 'test-encrypt-key-exactly-32-char';

jest.mock('../../../backend/db/connection', () => ({ query: jest.fn() }));
const path = require('path');
const db = require('../../../backend/db/connection');
const { checkApplyApproval, sha256 } = require(path.join(__dirname, '../../../backend/services/applyApproval'));

const PROJECT = '22222222-2222-4222-8222-222222222222';
const CR = '33333333-3333-4333-8333-333333333333';
const AUTHOR = '44444444-4444-4444-8444-444444444444';
const APPROVER = '55555555-5555-4555-8555-555555555555';
const APPLIER = '66666666-6666-4666-8666-666666666666';
const HCL = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n';

function crRow(overrides = {}) {
  return { id: CR, project_id: PROJECT, status: 'approved', approved_by: APPROVER, full_hcl: HCL, ...overrides };
}
const base = { projectId: PROJECT, changeRequestId: CR, applierId: APPLIER, hcl: HCL };

beforeEach(() => {
  process.env.APPLY_REQUIRES_APPROVAL = 'true';
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [crRow()] });
});
afterAll(() => { delete process.env.APPLY_REQUIRES_APPROVAL; });

describe('gate disabled (default)', () => {
  test('allows apply without any change request', async () => {
    delete process.env.APPLY_REQUIRES_APPROVAL;
    const r = await checkApplyApproval({ ...base, changeRequestId: undefined });
    expect(r).toEqual({ ok: true, gate: 'disabled' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('gate enabled', () => {
  test('refuses apply without change_request_id', async () => {
    const r = await checkApplyApproval({ ...base, changeRequestId: undefined });
    expect(r).toEqual(expect.objectContaining({ ok: false, status: 403, code: 'APPROVAL_REQUIRED' }));
    expect(db.query).not.toHaveBeenCalled();
  });

  test('refuses a malformed change_request_id without querying', async () => {
    const r = await checkApplyApproval({ ...base, changeRequestId: "x' OR 1=1 --" });
    expect(r.code).toBe('APPROVAL_REQUIRED');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('unknown change request and a different project look identical to the caller', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const missing = await checkApplyApproval(base);
    db.query.mockResolvedValueOnce({ rows: [crRow({ project_id: '77777777-7777-4777-8777-777777777777' })] });
    const otherProject = await checkApplyApproval(base);
    expect(missing).toEqual(otherProject);
    expect(missing).toEqual(expect.objectContaining({ status: 403, code: 'APPROVAL_NOT_FOUND' }));
  });

  test('an open or rejected change request cannot be applied', async () => {
    for (const status of ['open', 'rejected']) {
      db.query.mockResolvedValueOnce({ rows: [crRow({ status })] });
      const r = await checkApplyApproval(base);
      expect(r).toEqual(expect.objectContaining({ ok: false, status: 409, code: 'APPROVAL_NOT_APPROVED' }));
    }
  });

  test('the approver may not apply their own approval', async () => {
    db.query.mockResolvedValueOnce({ rows: [crRow({ approved_by: APPLIER })] });
    const r = await checkApplyApproval(base);
    expect(r).toEqual(expect.objectContaining({ status: 403, code: 'SELF_APPROVAL_FORBIDDEN' }));
  });

  test('HCL that differs from the approved version is refused', async () => {
    const r = await checkApplyApproval({ ...base, hcl: HCL + '# edited after approval\n' });
    expect(r).toEqual(expect.objectContaining({ status: 409, code: 'HCL_DIFFERS_FROM_APPROVED' }));
  });

  test('approved and merged requests with matching HCL are allowed', async () => {
    for (const status of ['approved', 'merged']) {
      db.query.mockResolvedValueOnce({ rows: [crRow({ status })] });
      const r = await checkApplyApproval(base);
      expect(r).toEqual({ ok: true, gate: 'enforced', changeRequestId: CR });
    }
  });

  test('the lookup is parameterised and scoped by the change request id', async () => {
    await checkApplyApproval(base);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE cr\.id = \$1/);
    expect(params).toEqual([CR]);
  });
});

test('sha256 is stable and hex-encoded', () => {
  expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  expect(sha256('abc')).toBe(sha256('abc'));
});
