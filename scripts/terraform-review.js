#!/usr/bin/env node
'use strict';
/**
 * Runs the TFGen automated Terraform review over a directory, from the command
 * line and in CI. It uses the same code as POST /api/modules/review, so local
 * results match what the app reports.
 *
 *   node scripts/terraform-review.js <dir> [--fail-on critical|high|medium|low]
 *                                          [--markdown <file>]
 *
 * Exit status: 0 when nothing is at or above --fail-on (default: high), 1 when
 * something is, 2 on usage errors. A markdown summary is written to --markdown and,
 * when GITHUB_STEP_SUMMARY is set, appended to the CI job summary.
 *
 * No dependencies: it only loads backend/services/codeReview.js, which is plain JS.
 */
const fs = require('fs');
const path = require('path');
const { reviewFiles, toMarkdownReport } = require(path.join(__dirname, '..', 'backend', 'services', 'codeReview'));

const ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function parseArgs(argv) {
  const args = { dir: null, failOn: 'high', markdown: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fail-on') args.failOn = argv[++i];
    else if (a === '--markdown') args.markdown = argv[++i];
    else if (!args.dir) args.dir = a;
    else return null;
  }
  if (!args.dir || !ORDER.includes(args.failOn)) return null;
  return args;
}

function collect(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tf|tfvars)$/.test(entry.name)) {
        out.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/terraform-review.js <dir> [--fail-on critical|high|medium|low] [--markdown <file>]');
    return 2;
  }
  const root = path.resolve(args.dir);
  if (!fs.existsSync(root)) { console.error(`no such directory: ${root}`); return 2; }

  const files = collect(root);
  const report = reviewFiles(files);
  const markdown = toMarkdownReport(report, { title: `Terraform review — ${path.relative(process.cwd(), root) || '.'}` });

  console.log(markdown);
  if (args.markdown) fs.writeFileSync(args.markdown, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');

  const threshold = ORDER.indexOf(args.failOn);
  const blocking = report.findings.filter((f) => ORDER.indexOf(f.severity) <= threshold);
  console.log(`${files.length} file(s) reviewed · ${blocking.length} finding(s) at or above ${args.failOn}`);
  return blocking.length > 0 ? 1 : 0;
}

process.exitCode = main();
