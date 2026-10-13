/**
 * tests/unit/backend/github-client.test.js
 * GitHub REST client: input validation, error mapping, token scrubbing,
 * pagination, path encoding and request bodies. global.fetch is mocked.
 */
'use strict';
const path = require('path');
const gh = require(path.join(__dirname, '../../../backend/services/githubClient'));

const TOKEN = 'ghp_TESTTOKEN0123456789abcdefghijklmnop';

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)),
  };
}

let fetchMock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

describe('input validation', () => {
  test('owner and repo must be GitHub-shaped', () => {
    expect(() => gh.validateOwnerRepo('acme', 'infra')).not.toThrow();
    expect(() => gh.validateOwnerRepo('acme/evil', 'infra')).toThrow(/owner/);
    expect(() => gh.validateOwnerRepo('acme', '..')).toThrow(/repository/);
    expect(() => gh.validateOwnerRepo('acme', 'a/b')).toThrow(/repository/);
  });

  test('branch names reject traversal, lock files and trailing separators', () => {
    expect(gh.validateBranch('feature/tf-review_1.2')).toBe('feature/tf-review_1.2');
    for (const bad of ['../x', 'a..b', 'x/', 'main.lock', '-rf', '.hidden', 'a//b', 'a b']) {
      expect(() => gh.validateBranch(bad)).toThrow(/branch/);
    }
  });

  test('file paths must be relative Terraform files', () => {
    expect(gh.validateTerraformPath('envs/prod/main.tf')).toBe('envs/prod/main.tf');
    for (const bad of ['/etc/x.tf', '../x.tf', 'main.txt', 'a//b.tf', 'x y.tf']) {
      expect(() => gh.validateTerraformPath(bad)).toThrow();
    }
  });

  test('path segments are percent-encoded individually', () => {
    expect(gh.encodePath('dir with space/a#b.tf')).toBe('dir%20with%20space/a%23b.tf');
  });
});

describe('request construction', () => {
  test('authorization header and API version are sent; the token is never in the URL', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { login: 'octo', name: null, avatar_url: 'x' }, { 'x-oauth-scopes': 'repo' }));
    const viewer = await gh.getViewer(TOKEN);
    expect(viewer).toEqual(expect.objectContaining({ login: 'octo', scopes: 'repo' }));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(url).not.toContain(TOKEN);
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(opts.signal).toBeDefined();
  });

  test('directory listings encode each path segment', async () => {
    fetchMock.mockResolvedValueOnce(res(200, []));
    await gh.listDirectory(TOKEN, 'acme', 'infra', 'dir with space', 'abc');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/infra/contents/dir%20with%20space?ref=abc');
  });

  test('putFile sends base64 content, the branch and the existing blob sha for updates', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { commit: { sha: 'c1', html_url: 'u' } }));
    await gh.putFile(TOKEN, 'acme', 'infra', { path: 'main.tf', branch: 'feat', message: 'm', content: 'resource "x" "y" {}', sha: 'blob1' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('resource "x" "y" {}');
    expect(body).toEqual(expect.objectContaining({ branch: 'feat', sha: 'blob1', message: 'm' }));
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
  });

  test('createPullRequestReview pins commit_id and forwards inline comments', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 9, state: 'COMMENTED', html_url: 'h' }));
    const comments = [{ path: 'main.tf', line: 2, side: 'RIGHT', body: 'b' }];
    await gh.createPullRequestReview(TOKEN, 'acme', 'infra', 7, { event: 'COMMENT', body: 'x', comments, commitId: 'sha9' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/repos\/acme\/infra\/pulls\/7\/reviews$/);
    expect(body).toEqual({ event: 'COMMENT', body: 'x', comments, commit_id: 'sha9' });
  });
});

describe('error mapping', () => {
  test('a missing branch is null, not an exception', async () => {
    fetchMock.mockResolvedValueOnce(res(404, { message: 'Not Found' }));
    await expect(gh.getBranchSha(TOKEN, 'acme', 'infra', 'nope')).resolves.toBeNull();
  });

  test('rate limiting is surfaced with the reset time', async () => {
    fetchMock.mockResolvedValueOnce(res(403, { message: 'API rate limit exceeded' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }));
    const err = await gh.getViewer(TOKEN).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.resetAt).toBe(new Date(1800000000 * 1000).toISOString());
  });

  test('the token is scrubbed from error messages GitHub might echo back', async () => {
    fetchMock.mockResolvedValueOnce(res(401, { message: `Bad credentials for ${TOKEN}` }));
    const err = await gh.getViewer(TOKEN).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('***');
  });

  test('timeouts and network failures map to 504', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValueOnce(timeout);
    const err = await gh.getViewer(TOKEN).catch((e) => e);
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/timed out/);
  });

  test('unknown upstream errors are reported as 502, not passed through', async () => {
    fetchMock.mockResolvedValueOnce(res(500, { message: 'internal' }));
    const err = await gh.getViewer(TOKEN).catch((e) => e);
    expect(err.status).toBe(502);
  });
});

describe('pagination', () => {
  test('listPullRequestFiles follows pages until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.tf`, status: 'added', patch: '@@ -0,0 +1 @@\n+x' }));
    const page2 = [{ filename: 'last.tf', status: 'modified' }];
    fetchMock.mockResolvedValueOnce(res(200, page1)).mockResolvedValueOnce(res(200, page2));
    const files = await gh.listPullRequestFiles(TOKEN, 'acme', 'infra', 7);
    expect(files).toHaveLength(101);
    expect(fetchMock.mock.calls[1][0]).toMatch(/page=2/);
    expect(files[100].path).toBe('last.tf');
  });

  test('listRepos clamps caller-supplied paging parameters', async () => {
    fetchMock.mockResolvedValueOnce(res(200, []));
    await gh.listRepos(TOKEN, { page: -5, perPage: 9999 });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('100');
  });
});
