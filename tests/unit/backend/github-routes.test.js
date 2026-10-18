/**
 * tests/unit/backend/github-routes.test.js
 *
 * Exercises the real /api/github router with the database and GitHub's HTTP
 * API replaced by in-memory fakes. The central guarantee under test: a review
 * is only POSTED to GitHub when the caller explicitly sets post: true.
 */
'use strict';
const crypto = require('crypto');
process.env.JWT_SECRET = 'unit-test-jwt-secret-padded-to-32-chars-minimum';
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret-padded-to-32-chars-min';
process.env.ENCRYPT_KEY = 'test-encrypt-key-exactly-32-char';

jest.mock('../../../backend/db/connection', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../../../backend/db/connection');
const { signAccessToken } = require('../../../backend/middleware/auth');
const { encrypt } = require('../../../backend/utils/awsCrypto');

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'eng@example.com', role: 'user' };
const AUTH = `Bearer ${signAccessToken(USER)}`;
const GH_TOKEN = 'ghp_TESTTOKEN0123456789abcdefghijklmnop';

const MAIN_TF = 'resource "aws_db_instance" "db" {\n  publicly_accessible = true\n  password = "hunter2"\n}\n';
const PR = {
  number: 7, title: 'Add database', state: 'open',
  head: { ref: 'feat', sha: 'headsha' }, base: { ref: 'main', sha: 'basesha' },
  html_url: 'https://github.com/acme/infra/pull/7',
};
const PR_FILES = [{
  filename: 'infra/main.tf', status: 'modified',
  patch: '@@ -0,0 +1,4 @@\n+resource "aws_db_instance" "db" {\n+  publicly_accessible = true\n+  password = "hunter2"\n+}\n',
}];
const DIR_LISTING = [
  { name: 'main.tf', path: 'infra/main.tf', type: 'file', size: MAIN_TF.length, sha: 'a' },
  { name: 'README.md', path: 'infra/README.md', type: 'file', size: 4, sha: 'b' },
];

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(k) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let connectionRow = null;
let githubCalls;

beforeEach(() => {
  connectionRow = { encrypted_token: encrypt(GH_TOKEN), login: 'octo', scopes: 'repo' };
  githubCalls = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/SELECT encrypted_token/.test(sql)) return { rows: connectionRow ? [connectionRow] : [], rowCount: connectionRow ? 1 : 0 };
    if (/SELECT login, scopes/.test(sql)) return { rows: connectionRow ? [{ login: 'octo', scopes: 'repo', created_at: new Date() }] : [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  global.fetch = jest.fn(async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const accept = (opts.headers && opts.headers.Accept) || '';
    githubCalls.push({ method, pathname: u.pathname, search: u.search });
    if (method === 'GET' && u.pathname === '/user') return res(200, { login: 'octo' }, { 'x-oauth-scopes': 'repo' });
    if (method === 'GET' && u.pathname === '/repos/acme/infra/pulls/7') return res(200, PR);
    if (method === 'GET' && u.pathname === '/repos/acme/infra/pulls/7/files') return res(200, PR_FILES);
    if (method === 'GET' && u.pathname === '/repos/acme/infra/contents/infra') return res(200, DIR_LISTING);
    if (method === 'GET' && u.pathname === '/repos/acme/infra/contents/infra/main.tf') {
      return accept.includes('raw') ? res(200, MAIN_TF) : res(404, { message: 'Not Found' });
    }
    if (method === 'POST' && /\/pulls\/7\/reviews$/.test(u.pathname)) return res(200, { id: 42, state: 'COMMENTED', html_url: 'https://github.com/review/42' });
    return res(404, { message: `unexpected ${method} ${u.pathname}` });
  });
});

const app = express();
app.use(express.json({ limit: '10mb' })); // same limit as server.js, so the route's own validation runs
app.use('/api/github', require(path.join(__dirname, '../../../backend/routes/github')));
app.use('/api/modules', require(path.join(__dirname, '../../../backend/routes/modules')));

describe('authentication and connection state', () => {
  test('every GitHub route requires a valid session', async () => {
    const r = await request(app).get('/api/github/connection');
    expect(r.status).toBe(401);
  });

  test('a user without a saved token gets a clear 409 instead of a GitHub call', async () => {
    connectionRow = null;
    const r = await request(app).get('/api/github/repos').set('Authorization', AUTH);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('GITHUB_NOT_CONNECTED');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('saving a token validates it with GitHub and never returns it', async () => {
    connectionRow = null;
    const r = await request(app).put('/api/github/connection').set('Authorization', AUTH)
      .send({ token: GH_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ connected: true, login: 'octo', scopes: 'repo' });
    expect(JSON.stringify(r.body)).not.toContain(GH_TOKEN);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO github_connections/.test(sql));
    expect(insert).toBeDefined();
    expect(insert[1][1]).not.toBe(GH_TOKEN); // stored encrypted, not plaintext
    expect(insert[1][1]).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  test('a malformed token is rejected before any GitHub call', async () => {
    const r = await request(app).put('/api/github/connection').set('Authorization', AUTH).send({ token: 'short' });
    expect(r.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('GET /connection reports metadata only', async () => {
    const r = await request(app).get('/api/github/connection').set('Authorization', AUTH);
    expect(r.body.connected).toBe(true);
    expect(r.body.login).toBe('octo');
    expect(JSON.stringify(r.body)).not.toContain(GH_TOKEN);
  });
});

describe('automated pull request review', () => {
  test('dry run returns the verdict and inline comments but posts nothing to GitHub', async () => {
    const r = await request(app).post('/api/github/repos/acme/infra/pulls/7/review').set('Authorization', AUTH).send({});
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.report.verdict).toBe('request_changes');
    expect(r.body.review.event).toBe('REQUEST_CHANGES');
    expect(r.body.review.comments.some((c) => c.path === 'infra/main.tf' && c.side === 'RIGHT')).toBe(true);
    expect(r.body.markdown).toMatch(/Terraform review for #7/);
    expect(githubCalls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('the whole module directory is read so cross-file rules see sibling files', async () => {
    await request(app).post('/api/github/repos/acme/infra/pulls/7/review').set('Authorization', AUTH).send({});
    expect(githubCalls.map((c) => c.pathname)).toContain('/repos/acme/infra/contents/infra');
    expect(githubCalls.some((c) => c.pathname === '/repos/acme/infra/contents/infra/main.tf')).toBe(true);
  });

  test('post: true submits one review pinned to the PR head commit', async () => {
    const r = await request(app).post('/api/github/repos/acme/infra/pulls/7/review').set('Authorization', AUTH).send({ post: true });
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.posted).toEqual({ id: 42, state: 'COMMENTED', htmlUrl: 'https://github.com/review/42' });
    const postCalls = githubCalls.filter((c) => c.method === 'POST');
    expect(postCalls).toHaveLength(1);
  });

  test('invalid owner names are rejected before any GitHub request', async () => {
    const r = await request(app).post('/api/github/repos/-bad/infra/pulls/7/review').set('Authorization', AUTH).send({});
    expect(r.status).toBe(400);
    expect(githubCalls).toEqual([]);
  });

  test('a PR that touches no Terraform files is approved without reading anything else', async () => {
    global.fetch.mockImplementation(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/repos/acme/infra/pulls/7') return res(200, PR);
      if (u.pathname === '/repos/acme/infra/pulls/7/files') return res(200, [{ filename: 'README.md', status: 'modified' }]);
      return res(404, {});
    });
    const r = await request(app).post('/api/github/repos/acme/infra/pulls/7/review').set('Authorization', AUTH).send({});
    expect(r.body.verdict).toBe('approve');
    expect(r.body.message).toMatch(/No Terraform files/);
  });
});

describe('module analysis routes (no GitHub needed)', () => {
  test('requires authentication', async () => {
    const r = await request(app).post('/api/modules/review').send({ files: [] });
    expect(r.status).toBe(401);
  });

  test('rejects traversal and non-Terraform paths', async () => {
    for (const p of ['../x.tf', '/abs.tf', 'main.txt', 'a/../../b.tf']) {
      const r = await request(app).post('/api/modules/analyze').set('Authorization', AUTH)
        .send({ files: [{ path: p, content: '' }] });
      expect(r.status).toBe(400);
    }
  });

  test('rejects duplicate paths and oversized requests', async () => {
    const dup = await request(app).post('/api/modules/analyze').set('Authorization', AUTH)
      .send({ files: [{ path: 'a.tf', content: '' }, { path: 'a.tf', content: '' }] });
    expect(dup.status).toBe(400);
    const big = await request(app).post('/api/modules/analyze').set('Authorization', AUTH)
      .send({ files: [{ path: 'a.tf', content: 'x'.repeat(600 * 1024) }] });
    expect(big.status).toBe(400);
  });

  test('analyze returns the inventory and issues', async () => {
    const r = await request(app).post('/api/modules/analyze').set('Authorization', AUTH)
      .send({ files: [{ path: 'main.tf', content: MAIN_TF }] });
    expect(r.status).toBe(200);
    expect(r.body.summary.resources).toBe(1);
    expect(r.body.issues.length).toBeGreaterThan(0);
  });

  test('autofix reports before and after verdicts and the changed files', async () => {
    const r = await request(app).post('/api/modules/autofix').set('Authorization', AUTH)
      .send({ files: [{ path: 'main.tf', content: MAIN_TF }] });
    expect(r.status).toBe(200);
    expect(r.body.before.verdict).toBe('request_changes');
    expect(r.body.applied.map((a) => a.attribute)).toEqual(expect.arrayContaining(['publicly_accessible']));
    expect(r.body.files[0].after).toMatch(/publicly_accessible = false/);
  });

  test('docs returns markdown and a Mermaid graph', async () => {
    const r = await request(app).post('/api/modules/docs').set('Authorization', AUTH)
      .send({ files: [{ path: 'main.tf', content: MAIN_TF }], title: 'DB module' });
    expect(r.body.markdown).toMatch(/^# DB module/);
    expect(r.body.mermaid).toMatch(/^flowchart LR/);
  });
});
