'use strict';
/**
 * Automated Terraform code review.
 *
 *   reviewFiles(files)            → findings from static security rules and module
 *                                    analysis, mapped to file:line, plus a verdict
 *   applyAutofixes(files, report) → safe, deterministic fixes for a known set of
 *                                    rules; never overwrites an expression
 *   toMarkdownReport(report)      → summary suitable for a PR comment or the UI
 *   buildPullRequestReview(...)   → GitHub review payload with inline comments
 *                                    placed only on lines that are in the diff
 *
 * Verdict policy (documented so teams can predict it):
 *   request_changes — at least one critical or high finding
 *   comment         — only medium/low/info findings
 *   approve         — no findings (posted to GitHub as COMMENT; bots do not approve)
 */
const { evaluateStaticRules, RULES: STATIC_RULE_INFO } = require('./staticSecurityRules');
const { analyzeModule } = require('./moduleAnalyzer');
const { parseBlocks, parseAttributes, makeLineIndex } = require('./hclScan');

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const STATIC_SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
const MODULE_SEVERITY = { error: 'high', warning: 'medium', info: 'low' };
// Module rules whose violation means credentials are exposed, not just messy code.
const CRITICAL_MODULE_RULES = new Set(['VAR_SECRET_DEFAULT', 'MODULE_INPUT_HARDCODED_SECRET']);
// Only these rules have a fix that is correct without human judgement.
const AUTOFIX_RULES = new Set(
  STATIC_RULE_INFO.filter((r) => r.autofix).map((r) => r.id)
);

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

/** Groups files by directory: a Terraform module is one directory. */
function groupByDirectory(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = dirOf(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return groups;
}

/**
 * Concatenates a group of files so cross-file references (a companion resource
 * in another file, a variable declared elsewhere) are visible to the rules.
 * Returns the combined text and a locator from combined line → { path, line }.
 */
function combine(group) {
  const starts = [];
  let line = 1;
  const parts = [];
  for (const f of group) {
    starts.push({ path: f.path, startLine: line });
    parts.push(f.content);
    line += String(f.content).split('\n').length; // the joining newline is counted by split
  }
  const locate = (globalLine) => {
    let hit = starts[0];
    for (const s of starts) if (s.startLine <= globalLine) hit = s; else break;
    return { path: hit.path, line: globalLine - hit.startLine + 1 };
  };
  return { text: parts.join('\n'), locate };
}

function severityOf(rule, raw) {
  if (rule.startsWith('CKV_') || rule.startsWith('TFGEN_')) {
    if (rule === 'TFGEN_HARDCODED_CREDENTIAL') return 'critical';
    return STATIC_SEVERITY[raw] || 'medium';
  }
  if (CRITICAL_MODULE_RULES.has(rule)) return 'critical';
  return MODULE_SEVERITY[raw] || 'low';
}

/**
 * Runs the review over `files` ([{ path, content }]).
 * options.changedPaths — optional iterable of paths. When given, only findings
 * in those files are reported (the rest of the module is still read so that
 * cross-file references resolve correctly).
 */
function reviewFiles(files, options = {}) {
  const input = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string');
  const changed = options.changedPaths ? new Set(options.changedPaths) : null;
  const findings = [];

  for (const group of groupByDirectory(input).values()) {
    const { text, locate } = combine(group);

    for (const f of evaluateStaticRules(text).findings) {
      const loc = locate(f.line || 1);
      findings.push({
        id: f.check_id,
        source: 'security',
        severity: severityOf(f.check_id, f.severity),
        path: loc.path,
        line: loc.line,
        subject: f.resource,
        message: f.message,
        suggestion: f.fix || null,
        autofix: f.autofix ? { resource: f.autofix.resource, attribute: f.autofix.attribute, value: f.autofix.value } : undefined,
        reference: f.guideline_url || null,
      });
    }

    const analysis = analyzeModule(group.map((f) => ({ path: f.path, content: f.content })));
    for (const issue of analysis.issues) {
      if (!issue.file) continue; // module-wide notes without a location are kept out of PR comments
      findings.push({
        id: issue.rule,
        source: 'module',
        severity: severityOf(issue.rule, issue.severity),
        path: issue.file,
        line: issue.line || 1,
        subject: issue.subject,
        message: issue.message,
        suggestion: issue.suggestion || null,
        reference: null,
      });
    }
  }

  const filtered = changed ? findings.filter((f) => changed.has(f.path)) : findings;
  const unique = dedupe(filtered);
  unique.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
    a.path.localeCompare(b.path) || a.line - b.line);

  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const f of unique) counts[f.severity]++;
  const verdict = counts.critical + counts.high > 0 ? 'request_changes'
    : counts.medium + counts.low + counts.info > 0 ? 'comment' : 'approve';

  return {
    verdict,
    counts,
    filesReviewed: input.length,
    findings: unique,
    generatedAt: new Date().toISOString(),
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const key = `${f.path}:${f.line}:${f.id}:${f.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── autofix ──────────────────────────────────────────────────────────────────

/**
 * Applies the deterministic fixes attached to findings. A fix is skipped (and
 * reported) when the attribute already holds an expression rather than a
 * literal, because replacing `var.x` with `true` would silently change intent.
 *
 * Returns { files: [{ path, before, after }], applied: [...], skipped: [...] }
 * where `files` contains only files that changed.
 */
function applyAutofixes(files, report) {
  const working = new Map((files || []).map((f) => [f.path, { path: f.path, before: f.content, content: f.content }]));
  const applied = [];
  const skipped = [];

  for (const finding of report.findings) {
    if (!finding.autofix) continue;
    const file = working.get(finding.path);
    if (!file) { skipped.push({ id: finding.id, path: finding.path, reason: 'file not provided' }); continue; }
    const { resource, attribute, value } = finding.autofix;
    const blocks = parseBlocks(file.content);
    const block = blocks.find((b) => b.type === 'resource' && b.labels.length === 2 &&
      `${b.labels[0]}.${b.labels[1]}` === resource);
    if (!block) { skipped.push({ id: finding.id, path: finding.path, reason: `resource ${resource} not found` }); continue; }

    const attrs = parseAttributes(file.content.slice(block.bodyStart, block.bodyEnd), { base: block.bodyStart });
    const existing = attrs.find((a) => a.name === attribute);
    if (existing && existing.value !== 'true' && existing.value !== 'false') {
      skipped.push({ id: finding.id, path: finding.path, reason: `${attribute} is an expression; review manually` });
      continue;
    }
    if (existing && existing.value === value) continue; // already compliant

    if (existing) {
      file.content = file.content.slice(0, existing.start) + `${attribute} = ${value}` + file.content.slice(existing.end);
    } else {
      const insertAt = block.bodyStart; // directly after the opening brace
      file.content = file.content.slice(0, insertAt) + `\n  ${attribute} = ${value}` + file.content.slice(insertAt);
    }
    applied.push({ id: finding.id, path: finding.path, resource, attribute, value });
  }

  const changed = [...working.values()]
    .filter((f) => f.content !== f.before)
    .map((f) => ({ path: f.path, before: f.before, after: f.content }));
  return { files: changed, applied, skipped };
}

// ─── pull request mapping ─────────────────────────────────────────────────────

/**
 * Parses a unified-diff `patch` (as returned by the GitHub pulls/files API) and
 * returns the set of NEW-file line numbers that GitHub accepts inline comments
 * on: added lines and context lines on the RIGHT side of the diff.
 */
function commentableLines(patch) {
  const lines = new Set();
  if (!patch) return lines;
  let newLine = 0;
  for (const raw of String(patch).split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (raw.startsWith('+')) { lines.add(newLine); newLine++; }
    else if (raw.startsWith('-')) { /* removed line: LEFT side only */ }
    else if (raw.startsWith(' ')) {
      // An empty string is only the artifact of a trailing newline, not a context line.
      if (newLine > 0) { lines.add(newLine); newLine++; }
    }
    // "\ No newline at end of file" and other markers do not advance either side
  }
  return lines;
}

/**
 * Builds the payload for POST /repos/{o}/{r}/pulls/{n}/reviews.
 * patchesByPath: Map<path, patch>. Findings on lines outside the diff cannot be
 * anchored inline, so they are listed in the review body instead.
 */
function buildPullRequestReview(report, patchesByPath, { title = 'Automated Terraform review' } = {}) {
  const comments = [];
  const unplaced = [];
  const commentable = new Map();
  for (const [path, patch] of patchesByPath) commentable.set(path, commentableLines(patch));

  for (const f of report.findings) {
    const where = `**${f.severity.toUpperCase()}** · \`${f.id}\``;
    const body = [where, '', f.message, f.suggestion ? `\n_Suggested fix:_ ${f.suggestion}` : ''].join('\n').trim();
    const lines = commentable.get(f.path);
    if (lines && lines.has(f.line)) {
      comments.push({ path: f.path, line: f.line, side: 'RIGHT', body });
    } else {
      unplaced.push({ ...f, body });
    }
  }

  const event = report.verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  const body = [
    `### ${title}`,
    '',
    `Verdict: **${report.verdict.replace('_', ' ')}** — ` +
      `${report.counts.critical} critical, ${report.counts.high} high, ${report.counts.medium} medium, ` +
      `${report.counts.low} low, ${report.counts.info} info.`,
    unplaced.length
      ? `\n${unplaced.length} finding(s) are on lines outside this diff:\n` +
        unplaced.map((f) => `- \`${f.path}:${f.line}\` ${f.severity} · \`${f.id}\` — ${f.message}`).join('\n')
      : '',
  ].join('\n').trim();

  return { event, body, comments, unplaced };
}

function toMarkdownReport(report, { title = 'Terraform review' } = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${title}`, '',
    `**Verdict:** ${report.verdict.replace('_', ' ')} · ${report.findings.length} finding(s) across ${report.filesReviewed} file(s)`, ''];
  if (report.findings.length === 0) {
    lines.push('No findings. Nothing blocks this change.', '');
    return lines.join('\n');
  }
  lines.push('| Severity | Rule | Location | Problem | Suggested fix |', '|---|---|---|---|---|');
  for (const f of report.findings) {
    lines.push(`| ${f.severity} | \`${f.id}\` | \`${f.path}:${f.line}\` | ${esc(f.message)} | ${esc(f.suggestion || '—')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  reviewFiles,
  applyAutofixes,
  commentableLines,
  buildPullRequestReview,
  toMarkdownReport,
  groupByDirectory,
  AUTOFIX_RULES,
};
