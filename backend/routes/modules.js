'use strict';
/**
 * Terraform module tooling that does not need GitHub:
 *
 *   POST /api/modules/analyze   { files: [{ path, content }] }  inventory, graph, issues
 *   POST /api/modules/review    { files: [...] }                 security + module findings, verdict
 *   POST /api/modules/autofix   { files: [...] }                 applies safe fixes, returns changed files
 *   POST /api/modules/docs      { files: [...], title? }         markdown reference + Mermaid graph
 *
 * `files` is an array of up to 200 Terraform files, each up to 512 KB and 4 MB in total.
 * Paths must be relative .tf / .tfvars paths.
 */
const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { analyzeModule, toMarkdown, toMermaid } = require('../services/moduleAnalyzer');
const { reviewFiles, applyAutofixes, toMarkdownReport } = require('../services/codeReview');

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function validateFiles(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'Provide a non-empty "files" array.' };
  if (input.length > MAX_FILES) return { error: `At most ${MAX_FILES} files per request.` };
  let total = 0;
  const seen = new Set();
  const files = [];
  for (const f of input) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      return { error: 'Each file needs a string "path" and a string "content".' };
    }
    const p = f.path;
    if (p.length > 300 || p.startsWith('/') || p.includes('..') || p.includes('\\') || !/\.(tf|tfvars)$/.test(p)) {
      return { error: `Invalid file path "${p.slice(0, 80)}". Use a relative .tf or .tfvars path.` };
    }
    if (seen.has(p)) return { error: `Duplicate file path "${p}".` };
    seen.add(p);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) return { error: `"${p}" is larger than 512 KB.` };
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { error: 'Request exceeds the 4 MB total limit.' };
    files.push({ path: p, content: f.content });
  }
  return { files };
}

function withFiles(handler) {
  return (req, res) => {
    const { files, error } = validateFiles(req.body?.files);
    if (error) return res.status(400).json({ error });
    try {
      return handler(files, req, res);
    } catch (err) {
      console.error('[modules] analysis failed:', err.message, req.correlationId);
      return res.status(500).json({ error: 'Analysis failed. Check the input for unusual syntax.', correlationId: req.correlationId });
    }
  };
}

router.post('/analyze', authMiddleware, withFiles((files, req, res) => {
  res.json(analyzeModule(files, { includeFiles: true }));
}));

router.post('/review', authMiddleware, withFiles((files, req, res) => {
  const report = reviewFiles(files);
  res.json({ ...report, markdown: toMarkdownReport(report) });
}));

router.post('/autofix', authMiddleware, withFiles((files, req, res) => {
  const report = reviewFiles(files);
  const fixed = applyAutofixes(files, report);
  const after = reviewFiles(files.map((f) => ({
    path: f.path,
    content: fixed.files.find((x) => x.path === f.path)?.after ?? f.content,
  })));
  res.json({
    before: { verdict: report.verdict, counts: report.counts },
    after: { verdict: after.verdict, counts: after.counts },
    applied: fixed.applied,
    skipped: fixed.skipped,
    files: fixed.files,
  });
}));

router.post('/docs', authMiddleware, withFiles((files, req, res) => {
  const analysis = analyzeModule(files, { includeFiles: true });
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 120) : 'Module';
  res.json({
    markdown: toMarkdown(analysis, { title }),
    mermaid: toMermaid(analysis),
    summary: analysis.summary,
  });
}));

module.exports = router;
module.exports.validateFiles = validateFiles;
