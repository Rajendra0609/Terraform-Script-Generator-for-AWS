'use strict';

// SECURITY FIX (M-06): stripHtml() previously relied on a hand-rolled regex
// blacklist (tag matching + a hardcoded list of CSS property names), which is
// a known-fragile pattern — the exact class of bug the frontend's own
// sanitizeHcl.js was fixed to move away from (see its BUG-007 comment) in
// favor of DOMParser. jsdom provides a real, spec-compliant DOMParser in
// Node, so the backend now mirrors the frontend's approach instead of
// re-implementing tag-stripping with regexes: parse the input as inert HTML
// (no scripts run, no resources fetched, no event handlers fire), read back
// only `textContent`, then strip any tags that entity-decoding revealed.
// This is not reachable via `dangerouslySetInnerHTML` anywhere today (see
// M-06 write-up) — this is a defense-in-depth fix for the stated invariant
// ("no HTML/style fragments persist"), in case a consuming sink is ever
// added later.
const { JSDOM } = require('jsdom');

// Constructing a JSDOM window is the expensive part; the DOMParser it
// exposes is cheap to instantiate per call, so build the window once at
// module load and reuse it for every stripHtml() call.
const _domParserWindow = new JSDOM('<!DOCTYPE html><body></body>').window;

// ─── Secret patterns (AWS, GitHub, generic passwords) ─────────────────────────
// Source: OWASP credential detection + AWS key format spec
const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID',       re: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Access Key',   re: /(?:aws_secret|secret_access_key)\s*=\s*["']?[A-Za-z0-9\/+=]{40}["']?/i },
  { name: 'AWS Session Token',       re: /(?:aws_session_token|session_token)\s*=\s*["'][A-Za-z0-9\/+=]{100,}["']/i },
  { name: 'Private Key Material',    re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub Token',            re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'Generic Password Field',  re: /password\s*=\s*["'][^"'${}\s]{8,}["']/i },
  { name: 'Generic Secret Field',    re: /secret\s*=\s*["'][^"'${}\s]{8,}["']/i },
];

/**
 * Scan HCL text for literal secrets.
 * Returns array of { name, excerpt } for each finding, or [] if clean.
 * Does NOT block — callers decide severity.
 */
function detectSecrets(input) {
  if (!input) return [];
  const text = String(input);
  const findings = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const match = text.match(re);
    if (match) {
      // Return a safe excerpt (never the full secret value)
      findings.push({ name, excerpt: match[0].slice(0, 20) + '…' });
    }
  }
  return findings;
}

/**
 * Check HCL for dangerous network rules (0.0.0.0/0 on privileged ports).
 * Returns array of warning strings.
 *
 * BUG-015 fix: the previous implementation split the HCL on block-boundary
 * keywords (resource / ingress { / egress {) which (a) discards the delimiter
 * itself and (b) can split a single ingress block across two fragments,
 * causing false negatives when the CIDR and the port land in different pieces.
 * The fix captures each complete ingress/egress block (including nested braces)
 * and checks the CIDR + port conditions on the full captured block only.
 */
function lintNetworkRules(hcl) {
  if (!hcl) return [];
  const text = String(hcl);

  const openWorldRe = /0\.0\.0\.0\/0|::\/0/;
  const privilegedPorts = [
    { port: 22,    name: 'SSH' },
    { port: 3389,  name: 'RDP' },
    { port: 5432,  name: 'PostgreSQL' },
    { port: 3306,  name: 'MySQL' },
    { port: 27017, name: 'MongoDB' },
    { port: 6379,  name: 'Redis' },
  ];

  if (!openWorldRe.test(text)) return [];

  // Extract complete ingress/egress blocks by tracking brace depth.
  // This correctly handles nested blocks and preserves all content needed
  // to check both the CIDR and the port in a single coherent block.
  const ingressBlocks = [];
  const blockStartRe = /\b(ingress|egress)\s*\{/g;
  let m;
  while ((m = blockStartRe.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    // Include the keyword + brace so port/cidr at the very start isn't missed
    ingressBlocks.push(text.slice(m.index, i));
  }

  const warnings = [];
  for (const block of ingressBlocks) {
    if (!openWorldRe.test(block)) continue;
    for (const { port, name } of privilegedPorts) {
      const portRe = new RegExp(`(from_port|to_port|port)\\s*=\\s*${port}\\b`);
      if (portRe.test(block)) {
        warnings.push(
          `SECURITY: Open-world CIDR (0.0.0.0/0 or ::/0) detected on port ${port} (${name}). ` +
          `Restrict ingress to known IP ranges.`
        );
      }
    }
  }
  return [...new Set(warnings)]; // deduplicate
}

// ─── Dangerous Terraform execution primitives ─────────────────────────────────
// SECURITY FIX (critical): guardHcl() previously only screened for literal
// secrets and HTML markup — it never blocked Terraform's own code-execution
// primitives. Any authenticated user could submit HCL containing a
// `provisioner "local-exec"` / `"remote-exec"` block or a `data "external"`
// block and have it executed for real by `terraform plan`/`init`/`apply`
// (data "external" runs during plan/refresh, not just apply). Combined with
// `use_real_credentials`, this allowed a single "read-only" plan request to
// exfiltrate a victim's live AWS credentials or pivot into the network.
//
// These patterns are deliberately conservative (they match the construct
// regardless of surrounding whitespace/formatting) and are applied to every
// HCL entry point via guardHcl(), so fmt/validate/suggest/plan/cost/scan/
// init/apply are all covered by the same check.
const DANGEROUS_CONSTRUCTS = [
  {
    name: 'local-exec provisioner',
    re: /provisioner\s+"local-exec"/i,
    hint: 'provisioner "local-exec" runs arbitrary shell commands on the machine executing Terraform and is not permitted here.',
  },
  {
    name: 'remote-exec provisioner',
    re: /provisioner\s+"remote-exec"/i,
    hint: 'provisioner "remote-exec" runs arbitrary shell commands on provisioned infrastructure and is not permitted here.',
  },
  {
    name: 'external data source',
    re: /data\s+"external"/i,
    hint: 'data "external" executes an arbitrary local program during plan/refresh (not just apply) and is not permitted here.',
  },
];

/**
 * Scan HCL for Terraform constructs that cause arbitrary code execution
 * on the machine running `terraform` (host or sandbox container) — as
 * opposed to detectSecrets(), which only looks for literal credential
 * material. Returns [] if none found.
 */
function detectDangerousConstructs(input) {
  if (!input) return [];
  const text = String(input);
  const findings = [];
  for (const { name, re, hint } of DANGEROUS_CONSTRUCTS) {
    if (re.test(text)) findings.push({ name, hint });
  }
  return findings;
}

// ─── HTML/CSS tag stripper (jsdom DOMParser-based, see M-06 above) ────────────
const htmlTagRe = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^>]*?)?>/;
const htmlTagGlobalRe = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^>]*?)?>/g;
const htmlEntityRe = /&(?:lt|gt|amp|quot|#39);/i;
// Same property list the frontend's sanitizeHcl.js strips, kept in sync so
// both layers agree on what counts as "leaked styling" (M-06).
const CSS_PROPS_RE = /\b(?:color|font-weight|font-style|display|user-select|text-align|width|padding[a-z-]*|flex[a-z-]*)\s*:/i;

function looksSuspicious(text) {
  return htmlTagRe.test(text)
    || htmlEntityRe.test(text)
    || CSS_PROPS_RE.test(text)
    || /\bstyle\s*=\s*["'][^"']*["']/i.test(text)
    || /\bclass\s*=\s*["'][^"']*["']/i.test(text);
}

function stripCssFragments(t) {
  t = t.replace(/(?:["']?)?color:\s*#?[A-Fa-f0-9]{3,8}\s*;?/gi, '');
  t = t.replace(/(?:["']?)?color:\s*[a-z]+\s*;?/gi, '');
  t = t.replace(/(?:["']?)?font-weight:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?font-style:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?display:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?user-select:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?text-align:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?width:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?padding[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?flex[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
  t = t.replace(/(?:["']?)?inline-block\s*;?/gi, '');
  t = t.replace(/style=\s*["'][^"']*["']/gi, '');
  t = t.replace(/\bclass=["'][^"']*["']/gi, '');
  return t;
}

function stripHtml(input) {
  if (!input) return '';
  const original = String(input);

  // Fast path: skip parsing entirely if nothing suspicious is present —
  // this is also what keeps stripHtml() cheap enough to call on every save.
  if (!looksSuspicious(original)) return original;

  try {
    // Real parser instead of a regex tag-blacklist (M-06): parseFromString
    // builds an inert document — no scripts execute, no resources load, no
    // event handlers fire — mirroring frontend/src/utils/sanitizeHcl.js's
    // DOMParser approach exactly, so both layers behave consistently.
    const parser = new _domParserWindow.DOMParser();
    const doc = parser.parseFromString(original, 'text/html');
    let t = doc.body ? (doc.body.textContent || '') : '';

    // textContent already yields decoded entities, which can reveal tags
    // that were double-encoded (e.g. &lt;script&gt;). Strip those too.
    t = t.replace(htmlTagGlobalRe, '');

    // Remove inline CSS fragments left behind as plain text (e.g. pasted
    // from a rich-text editor without real <style>/style= wrappers).
    t = stripCssFragments(t);

    // Collapse excessive blank lines
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    return t;
  } catch (e) {
    // Parser failure fallback — should be unreachable in practice (jsdom's
    // DOMParser doesn't throw on malformed input), but fail safe rather than
    // returning unsanitized content.
    let t = original.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    t = t.replace(htmlTagGlobalRe, '');
    t = stripCssFragments(t);
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }
}

function hasMarkup(input) {
  if (!input) return false;
  return looksSuspicious(String(input));
}

module.exports = { stripHtml, detectSecrets, detectDangerousConstructs, lintNetworkRules, hasMarkup };
