'use strict';
/**
 * Minimal GitHub REST client (Node built-in fetch, no dependencies).
 *
 * Security notes:
 *   - The base URL comes from configuration only, never from request input, so
 *     the client cannot be pointed at an arbitrary host (no SSRF through it).
 *   - Owner, repo, branch and file-path inputs are validated before they are
 *     placed in a URL; path segments are percent-encoded individually.
 *   - Tokens are only sent in the Authorization header. Error messages are
 *     built from GitHub's response body and scrubbed of the token value.
 *   - Every request has a timeout; rate-limit responses are surfaced with the
 *     reset time instead of being retried blindly.
 */

const DEFAULT_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TIMEOUT_MS = Number(process.env.GITHUB_TIMEOUT_MS) || 15000;
const MAX_PR_FILES = 300;        // GitHub's own cap for the pulls/files endpoint
const MAX_PAGES = 10;

class GitHubError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function validateOwnerRepo(owner, repo) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) {
    throw new GitHubError(400, 'Invalid GitHub owner name.');
  }
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubError(400, 'Invalid GitHub repository name.');
  }
  return { owner, repo };
}

/** Branch names: a conservative subset of git check-ref-format. */
function validateBranch(name) {
  const ok = typeof name === 'string' &&
    name.length >= 1 && name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) &&
    !name.includes('..') && !name.includes('//') &&
    !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') &&
    !name.includes('/.') && !name.startsWith('.');
  if (!ok) throw new GitHubError(400, 'Invalid branch name.');
  return name;
}

/** Repository-relative Terraform file path. */
function validateTerraformPath(p) {
  const ok = typeof p === 'string' && p.length >= 1 && p.length <= 300 &&
    /^[A-Za-z0-9._\/-]+$/.test(p) &&
    !p.startsWith('/') && !p.includes('..') && !p.includes('//') &&
    /\.(tf|tfvars)$/.test(p);
  if (!ok) throw new GitHubError(400, 'Path must be a relative .tf or .tfvars file path.');
  return p;
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function scrub(text, token) {
  let out = String(text || '');
  if (token) out = out.split(token).join('***');
  return out.slice(0, 500);
}

/**
 * One request to the GitHub API.
 * Returns { status, data, headers }. `raw` returns the body as text.
 */
async function ghFetch(token, method, pathname, { query, body, raw = false } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${DEFAULT_API.replace(/\/+$/, '')}${pathname}${qs}`;
  const headers = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tfgen-backend',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new GitHubError(504, `GitHub request ${reason}.`);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = `GitHub returned ${res.status}.`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = `GitHub: ${parsed.message}`;
    } catch (_) { /* non-JSON error body */ }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) || null;
      throw new GitHubError(429, 'GitHub rate limit reached. Try again later.', {
        resetAt: reset ? new Date(reset * 1000).toISOString() : null,
      });
    }
    const status = res.status === 404 ? 404 : res.status === 401 ? 401 : res.status === 403 ? 403
      : res.status === 422 ? 422 : 502;
    throw new GitHubError(status, scrub(message, token));
  }

  if (raw) return { status: res.status, data: text, headers: res.headers };
  if (res.status === 204 || text === '') return { status: res.status, data: null, headers: res.headers };
  return { status: res.status, data: JSON.parse(text), headers: res.headers };
}

/** Follows GitHub's page-numbered pagination up to `maxItems`. */
async function ghPaginate(token, pathname, query = {}, maxItems = 300) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES && items.length < maxItems; page++) {
    const { data } = await ghFetch(token, 'GET', pathname, { query: { per_page: 100, ...query, page } });
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < 100) break;
  }
  return items.slice(0, maxItems);
}

// ─── public API ───────────────────────────────────────────────────────────────

async function getViewer(token) {
  const { data, headers } = await ghFetch(token, 'GET', '/user');
  return {
    login: data.login,
    name: data.name || null,
    avatarUrl: data.avatar_url || null,
    // Classic PATs report scopes here; fine-grained tokens do not.
    scopes: headers.get('x-oauth-scopes') || null,
  };
}

async function listRepos(token, { page = 1, perPage = 30 } = {}) {
  const p = Math.min(Math.max(Number(page) || 1, 1), 1000);
  const pp = Math.min(Math.max(Number(perPage) || 30, 1), 100);
  const { data } = await ghFetch(token, 'GET', '/user/repos', {
    query: { sort: 'updated', per_page: pp, page: p, affiliation: 'owner,collaborator,organization_member' },
  });
  return data.map(repoSummary);
}

async function getRepo(token, owner, repo) {
  validateOwnerRepo(owner, repo);
  const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}`);
  return repoSummary(data);
}

function repoSummary(r) {
  return {
    fullName: r.full_name,
    owner: r.owner?.login,
    name: r.name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    permissions: r.permissions || null,
  };
}

async function listPullRequests(token, owner, repo, { state = 'open', perPage = 30 } = {}) {
  validateOwnerRepo(owner, repo);
  const st = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/pulls`, {
    query: { state: st, per_page: Math.min(Math.max(Number(perPage) || 30, 1), 100) },
  });
  return data.map((p) => ({
    number: p.number, title: p.title, state: p.state, draft: Boolean(p.draft),
    author: p.user?.login, head: p.head?.ref, headSha: p.head?.sha, base: p.base?.ref,
    htmlUrl: p.html_url, updatedAt: p.updated_at,
  }));
}

async function getPullRequest(token, owner, repo, number) {
  validateOwnerRepo(owner, repo);
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw new GitHubError(400, 'Invalid pull request number.');
  const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/pulls/${n}`);
  return {
    number: data.number, title: data.title, state: data.state,
    headRef: data.head?.ref, headSha: data.head?.sha,
    baseRef: data.base?.ref, baseSha: data.base?.sha,
    htmlUrl: data.html_url,
  };
}

/** Changed files of a PR, including the unified-diff `patch` for inline comment placement. */
async function listPullRequestFiles(token, owner, repo, number) {
  validateOwnerRepo(owner, repo);
  const files = await ghPaginate(token, `/repos/${owner}/${repo}/pulls/${Number(number)}/files`, {}, MAX_PR_FILES);
  return files.map((f) => ({
    path: f.filename, status: f.status, patch: f.patch || null, sha: f.sha,
    previousPath: f.previous_filename || null,
  }));
}

async function getBranchSha(token, owner, repo, branch) {
  validateOwnerRepo(owner, repo);
  validateBranch(branch);
  try {
    const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`);
    return data?.object?.sha || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function createBranch(token, owner, repo, branch, sha) {
  validateOwnerRepo(owner, repo);
  validateBranch(branch);
  const { data } = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha },
  });
  return data?.object?.sha || null;
}

/** Contents API metadata for one file at a ref; null when absent. */
async function getFileMeta(token, owner, repo, path, ref) {
  validateOwnerRepo(owner, repo);
  try {
    const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/contents/${encodePath(path)}`, { query: { ref } });
    return Array.isArray(data) ? null : { sha: data.sha, size: data.size, type: data.type };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getFileText(token, owner, repo, path, ref) {
  validateOwnerRepo(owner, repo);
  const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    query: { ref }, raw: true,
  });
  return data;
}

/** Directory listing at a ref; empty array when the directory does not exist. */
async function listDirectory(token, owner, repo, dir, ref) {
  validateOwnerRepo(owner, repo);
  const target = dir === '.' || !dir ? '' : `/${encodePath(dir)}`;
  try {
    const { data } = await ghFetch(token, 'GET', `/repos/${owner}/${repo}/contents${target}`, { query: { ref } });
    return Array.isArray(data) ? data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha })) : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function putFile(token, owner, repo, { path, branch, message, content, sha }) {
  validateOwnerRepo(owner, repo);
  validateBranch(branch);
  validateTerraformPath(path);
  const body = {
    message: String(message || `Update ${path}`).slice(0, 200),
    content: Buffer.from(String(content), 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  const { data } = await ghFetch(token, 'PUT', `/repos/${owner}/${repo}/contents/${encodePath(path)}`, { body });
  return { path, commitSha: data?.commit?.sha || null, htmlUrl: data?.commit?.html_url || null };
}

async function createPullRequest(token, owner, repo, { title, head, base, body, draft = false }) {
  validateOwnerRepo(owner, repo);
  validateBranch(head);
  validateBranch(base);
  const { data } = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    body: { title: String(title).slice(0, 256), head, base, body: String(body || '').slice(0, 65000), draft: Boolean(draft) },
  });
  return { number: data.number, htmlUrl: data.html_url, state: data.state };
}

async function createPullRequestReview(token, owner, repo, number, { event, body, comments = [], commitId }) {
  validateOwnerRepo(owner, repo);
  const payload = { event, body: String(body || '').slice(0, 65000), comments };
  if (commitId) payload.commit_id = commitId;
  const { data } = await ghFetch(token, 'POST', `/repos/${owner}/${repo}/pulls/${Number(number)}/reviews`, { body: payload });
  return { id: data.id, state: data.state, htmlUrl: data.html_url };
}

module.exports = {
  GitHubError,
  validateOwnerRepo,
  validateBranch,
  validateTerraformPath,
  encodePath,
  getViewer,
  listRepos,
  getRepo,
  listPullRequests,
  getPullRequest,
  listPullRequestFiles,
  getBranchSha,
  createBranch,
  getFileMeta,
  getFileText,
  listDirectory,
  putFile,
  createPullRequest,
  createPullRequestReview,
  // exported for tests
  _internal: { ghFetch, ghPaginate, scrub },
};
