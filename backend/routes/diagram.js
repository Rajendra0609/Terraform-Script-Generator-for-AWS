'use strict';
/**
 * /api/diagram — AWS architecture diagram generator
 *
 * POST /api/diagram/generate
 *   Body: { hcl?: string, files?: [{ filename: string, content: string }] }
 *   Returns: { architecture, svg, drawioXml, warnings, stats }
 *
 * Accepts either a single `hcl` string (e.g. the Studio's combined output)
 * or an array of `files` (multi-file upload / paste). At least one of the
 * two is required. Parsing and rendering are pure CPU work — no external
 * calls — so this stays fast and side-effect free.
 */
const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { parseHclSources } = require('../services/hclArchParser');
const { buildArchitectureModel } = require('../services/architectureMapper');
const { renderArchitectureSvg, CATEGORY_COLOR } = require('../services/architectureSvg');
const { renderArchitectureDrawio } = require('../services/architectureDrawio');

const MAX_TOTAL_CHARS = 2_000_000; // ~2MB of combined HCL — generous for a full project, still bounded
const MAX_FILES = 200;

// ── Per-user rate limiter (sliding window, in-process) — same pattern as hcl-explain.js ──
const _callLog = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_CALLS = 30;
function checkRateLimit(userId) {
  const now = Date.now();
  const calls = (_callLog.get(userId) || []).filter(t => t > now - WINDOW_MS);
  if (calls.length >= MAX_CALLS) return false;
  calls.push(now);
  _callLog.set(userId, calls);
  return true;
}

router.use(authMiddleware);

router.post('/generate', (req, res) => {
  try {
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Rate limit: max 30 diagram generations per 5 minutes.' });
    }

    const { hcl, files } = req.body || {};

    let sources = [];
    if (Array.isArray(files) && files.length) {
      if (files.length > MAX_FILES) {
        return res.status(400).json({ error: `Too many files (max ${MAX_FILES}).` });
      }
      sources = files
        .filter(f => f && typeof f.content === 'string')
        .map(f => ({ filename: String(f.filename || 'unnamed.tf').slice(0, 255), content: f.content }));
    } else if (typeof hcl === 'string' && hcl.trim()) {
      sources = [{ filename: 'main.tf', content: hcl }];
    }

    if (!sources.length) {
      return res.status(400).json({ error: 'Provide either "hcl" (string) or "files" (array of {filename, content}).' });
    }

    const totalChars = sources.reduce((sum, s) => sum + (s.content ? s.content.length : 0), 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      return res.status(400).json({ error: `Combined Terraform input is too large (${totalChars} chars, max ${MAX_TOTAL_CHARS}).` });
    }
    if (totalChars === 0) {
      return res.status(400).json({ error: 'No Terraform content found in the provided input.' });
    }

    const parsed = parseHclSources(sources);

    if (!parsed.resources.length) {
      return res.json({
        architecture: null,
        svg: null,
        drawioXml: null,
        warnings: [...parsed.parseWarnings, 'No Terraform resource blocks were found in the provided input.'],
        stats: { total_resources: 0, mapped_resources: 0, uncategorized_resources: 0, vpc_count: 0, subnet_count: 0, connection_count: 0 },
      });
    }

    const architecture = buildArchitectureModel(parsed);
    const { svg, width, height } = renderArchitectureSvg(architecture);
    const drawioXml = renderArchitectureDrawio(architecture, CATEGORY_COLOR);

    return res.json({
      architecture,
      svg,
      svgWidth: width,
      svgHeight: height,
      drawioXml,
      warnings: architecture.warnings,
      stats: architecture.stats,
    });
  } catch (err) {
    // Defensive catch-all: a malformed/unexpected Terraform input should never 500 the
    // request (acceptance criteria: "handles a reasonable set of Terraform examples
    // without crashing"). Log server-side, return a clean 400 to the client.
    // eslint-disable-next-line no-console
    console.error('[diagram] generate failed:', err);
    return res.status(400).json({ error: `Could not generate a diagram from the provided Terraform: ${err.message}` });
  }
});

module.exports = router;
