'use strict';
/**
 * GitHub integration: connect an account, browse repositories and pull
 * requests, run the automated Terraform review on a PR, and open a PR that
 * carries a project's generated HCL.
 *
 *   GET    /api/github/connection
 *   PUT    /api/github/connection                 { token }
 *   DELETE /api/github/connection
 *   GET    /api/github/repos?page&per_page
 *   GET    /api/github/repos/:owner/:repo/pulls?state
 *   POST   /api/github/repos/:owner/:repo/pulls/:number/review
 *          { post?: boolean }   — dry run unless post === true
 *   POST   /api/github/projects/:id/pull-request
 *          { owner, repo, branch, path?, baseBranch?, title? }
 */
const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { audit, attachAuditResponseHook } = require('../middleware/audit');
const { authoriseProject } = require('../utils/projectAccess');
const db = require('../db/connection');
const gh = require('../services/githubClient');
const store = require('../services/githubStore');
const {
  reviewFiles,
  applyAutofixes,
  buildPullRequestReview,
  toMarkdownReport,
} = require('../services/codeReview');

const { GitHubError } = gh;
const MAX_REVIEW_DIRS = 20;
const MAX_REVIEW_FILES = 150;
const MAX_FILE_BYTES = 512 * 1024;

router.use(attachAuditResponseHook);

function sendError(req, res, err) {
  if (err instanceof GitHubError) {
    const body = { error: err.message, correlationId: req.correlationId };
    if (err.resetAt) body.resetAt = err.resetAt;
    return res.status(err.status).json(body);
  }
  if (err && err.message && err.message.startsWith('[FATAL]')) {
    return res.status(500).json({ error: 'Server encryption is not configured.', correlationId: req.correlationId });
  }
  console.error('[github] unexpected error:', err && err.message, req.correlationId);
  return res.status(500).json({ error: 'Unexpected error talking to GitHub.', correlationId: req.correlationId });
}

async function requireConnection(req, res) {
  const conn = await store.getConnection(req.user.id);
  if (!conn) {
    res.status(409).json({
      error: 'GitHub is not connected. Save a personal access token with PUT /api/github/connection first.',
      code: 'GITHUB_NOT_CONNECTED',
    });
    return null;
  }
  return conn;
}

const isTerraformPath = (p) => /\.(tf|tfvars)$/.test(p);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/**
 * Loads every Terraform file in the directories touched by the PR, at the PR
 * head commit. Reviewing only the changed files would make cross-file checks
 * (variables declared in variables.tf, companion resources) report false errors.
 */
async function loadModuleFiles(token, owner, repo, dirs, ref) {
  const out = [];
  for (const dir of dirs.slice(0, MAX_REVIEW_DIRS)) {
    const entries = await gh.listDirectory(token, owner, repo, dir, ref);
    const tf = entries.filter((e) => e.type === 'file' && isTerraformPath(e.name) && e.size <= MAX_FILE_BYTES);
    for (const e of tf) {
      if (out.length >= MAX_REVIEW_FILES) return out;
      out.push({ path: e.path, content: await gh.getFileText(token, owner, repo, e.path, ref) });
    }
  }
  return out;
}

// ─── connection ───────────────────────────────────────────────────────────────

router.get('/connection', authMiddleware, async (req, res) => {
  try {
    const meta = await store.getConnectionMeta(req.user.id);
    if (!meta) return res.json({ connected: false });
    return res.json({ connected: true, login: meta.login, scopes: meta.scopes, connectedAt: meta.connectedAt });
  } catch (err) {
    return sendError(req, res, err);
  }
});

router.put('/connection', authMiddleware, audit('github.connection.save'), async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (token.length < 20 || token.length > 255 || /\s/.test(token)) {
    return res.status(400).json({ error: 'Provide a GitHub personal access token (a single string without spaces).' });
  }
  try {
    const viewer = await gh.getViewer(token);
    await store.saveConnection(req.user.id, token, viewer);
    return res.json({ connected: true, login: viewer.login, scopes: viewer.scopes });
  } catch (err) {
    return sendError(req, res, err);
  }
});

router.delete('/connection', authMiddleware, audit('github.connection.delete'), async (req, res) => {
  try {
    const removed = await store.deleteConnection(req.user.id);
    return res.json({ connected: false, removed });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ─── browsing ─────────────────────────────────────────────────────────────────

router.get('/repos', authMiddleware, async (req, res) => {
  try {
    const conn = await requireConnection(req, res);
    if (!conn) return;
    const repos = await gh.listRepos(conn.token, { page: req.query.page, perPage: req.query.per_page });
    return res.json({ repos });
  } catch (err) {
    return sendError(req, res, err);
  }
});

router.get('/repos/:owner/:repo/pulls', authMiddleware, async (req, res) => {
  try {
    const conn = await requireConnection(req, res);
    if (!conn) return;
    const pulls = await gh.listPullRequests(conn.token, req.params.owner, req.params.repo, { state: req.query.state });
    return res.json({ pulls });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ─── review ───────────────────────────────────────────────────────────────────

router.post('/repos/:owner/:repo/pulls/:number/review', authMiddleware,
  audit('github.pull_request.review'), async (req, res) => {
    try {
      const conn = await requireConnection(req, res);
      if (!conn) return;
      const { owner, repo } = gh.validateOwnerRepo(req.params.owner, req.params.repo);
      const number = Number(req.params.number);
      const post = req.body?.post === true;

      const pr = await gh.getPullRequest(conn.token, owner, repo, number);
      const changed = (await gh.listPullRequestFiles(conn.token, owner, repo, number))
        .filter((f) => f.status !== 'removed' && isTerraformPath(f.path));

      if (changed.length === 0) {
        return res.json({ dryRun: !post, pr, verdict: 'approve', message: 'No Terraform files changed in this pull request.' });
      }

      const dirs = [...new Set(changed.map((f) => dirOf(f.path)))];
      const files = await loadModuleFiles(conn.token, owner, repo, dirs, pr.headSha);
      const report = reviewFiles(files, { changedPaths: changed.map((f) => f.path) });
      const patches = new Map(changed.map((f) => [f.path, f.patch]));
      const review = buildPullRequestReview(report, patches, { title: `Automated Terraform review · #${number}` });

      if (!post) {
        return res.json({
          dryRun: true, pr, report, review,
          markdown: toMarkdownReport(report, { title: `Terraform review for #${number}` }),
        });
      }
      const posted = await gh.createPullRequestReview(conn.token, owner, repo, number, {
        event: review.event, body: review.body, comments: review.comments, commitId: pr.headSha,
      });
      return res.json({ dryRun: false, pr, report, posted });
    } catch (err) {
      return sendError(req, res, err);
    }
  });

// ─── project → pull request ──────────────────────────────────────────────────

router.post('/projects/:id/pull-request', authMiddleware, audit('github.pull_request.create'), async (req, res) => {
  const project = await authoriseProject(req, res, ['editor', 'deployer', 'admin']);
  if (!project) return; // authoriseProject has already written the 403/404
  try {
    const conn = await requireConnection(req, res);
    if (!conn) return;
    const { owner, repo } = gh.validateOwnerRepo(req.body?.owner, req.body?.repo);
    const branch = gh.validateBranch(req.body?.branch);
    const path = gh.validateTerraformPath(req.body?.path || 'main.tf');

    const { rows } = await db.query('SELECT last_hcl FROM projects WHERE id = $1', [project.id]);
    const hcl = rows[0]?.last_hcl;
    if (!hcl || !String(hcl).trim()) {
      return res.status(409).json({ error: 'This project has no generated HCL yet. Save it in the Builder first.' });
    }
    if (Buffer.byteLength(hcl, 'utf8') > MAX_FILE_BYTES) {
      return res.status(413).json({ error: 'Generated HCL is larger than the 512 KB pull request limit.' });
    }

    const repoInfo = await gh.getRepo(conn.token, owner, repo);
    const base = gh.validateBranch(req.body?.baseBranch || repoInfo.defaultBranch);
    const baseSha = await gh.getBranchSha(conn.token, owner, repo, base);
    if (!baseSha) return res.status(404).json({ error: `Base branch "${base}" was not found.` });
    if (await gh.getBranchSha(conn.token, owner, repo, branch)) {
      return res.status(409).json({ error: `Branch "${branch}" already exists. Choose another branch name.` });
    }

    // Review the generated code before it leaves the server, and put the
    // result in the PR body so reviewers see it without re-running anything.
    const report = reviewFiles([{ path, content: hcl }]);

    await gh.createBranch(conn.token, owner, repo, branch, baseSha);
    const existing = await gh.getFileMeta(conn.token, owner, repo, path, branch);
    const commit = await gh.putFile(conn.token, owner, repo, {
      path, branch, content: hcl,
      message: `Update ${path} from TFGen project "${project.name}"`,
      sha: existing?.sha,
    });
    const title = String(req.body?.title || `Update ${path} from TFGen (${project.name})`).slice(0, 200);
    const body = [
      `Generated from TFGen project **${project.name}**.`,
      '',
      toMarkdownReport(report, { title: 'Automated review of the generated code' }),
    ].join('\n');
    const pr = await gh.createPullRequest(conn.token, owner, repo, { title, head: branch, base, body });
    return res.status(201).json({ pullRequest: pr, commit, verdict: report.verdict, counts: report.counts });
  } catch (err) {
    return sendError(req, res, err);
  }
});

module.exports = router;
module.exports.loadModuleFiles = loadModuleFiles;
