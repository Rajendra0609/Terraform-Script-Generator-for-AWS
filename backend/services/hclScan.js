'use strict';
/**
 * hclScan — dependency-free structural scanner for HCL source text.
 *
 * Why this exists: the static security rules and the module analyzer need to
 * know where blocks and attributes begin and end, and which line they are on.
 * Plain regular expressions over the whole file cannot tell a `port = 22` that
 * belongs to one security group from one that belongs to the next, and they
 * happily match text inside comments and strings. This scanner understands:
 *
 *   - "..." strings with \-escapes and ${...} / %{...} interpolation (nested)
 *   - # and // line comments, and /* block comments *\/
 *   - heredocs (<<EOF / <<-EOF) whose bodies are opaque
 *   - bracket depth for { } [ ] ( ), so blocks and attributes are found at
 *     the right nesting level
 *
 * It is NOT an HCL evaluator: references are not resolved and expressions are
 * not computed. Values are returned as the literal source text.
 *
 * All offsets returned are absolute offsets into the text that was passed in,
 * so callers can splice replacements back into the original file.
 */

// Matches the header of a block: `type`, `type "label"`, `type "a" "b"` ...
const HEADER_RE = /^([A-Za-z_][\w-]*)((?:\s+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)$/;
const LABEL_RE = /"([^"\n]*)"|([A-Za-z_][\w-]*)/g;

/**
 * Single left-to-right pass producing:
 *   code  — the source with comments replaced by spaces (newlines kept). String
 *           contents and heredoc bodies are preserved so callers can match them.
 *   depth — depth[i] is the bracket nesting level at character i. Opening
 *           brackets carry the level they open at; closing brackets carry the
 *           level they close back to. Characters inside strings and heredocs
 *           carry the level of the surrounding code.
 */
function scanHcl(text) {
  const src = String(text == null ? '' : text);
  const n = src.length;
  const out = new Array(n);
  const depth = new Int32Array(n);
  let d = 0;
  let i = 0;
  // Context stack: 'str' (inside "...") or 'interp' (inside ${...}, with a
  // brace counter so nested braces inside the interpolation are balanced).
  const stack = [];

  while (i < n) {
    const ch = src[i];
    const top = stack.length ? stack[stack.length - 1] : null;

    if (top && top.kind === 'str') {
      depth[i] = d;
      if (ch === '\\' && i + 1 < n) {
        out[i] = ch; out[i + 1] = src[i + 1]; depth[i + 1] = d; i += 2; continue;
      }
      if (ch === '"') { stack.pop(); out[i] = ch; i++; continue; }
      if ((ch === '$' || ch === '%') && src[i + 1] === '{') {
        stack.push({ kind: 'interp', braces: 1 });
        out[i] = ch; out[i + 1] = '{'; depth[i + 1] = d; i += 2; continue;
      }
      out[i] = ch; i++; continue;
    }

    if (top && top.kind === 'interp') {
      depth[i] = d;
      if (ch === '"') { stack.push({ kind: 'str' }); out[i] = ch; i++; continue; }
      if (ch === '{') top.braces++;
      else if (ch === '}') {
        top.braces--;
        if (top.braces === 0) { stack.pop(); out[i] = ch; i++; continue; }
      }
      out[i] = ch; i++; continue;
    }

    // ── code context ──────────────────────────────────────────────────────
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') { out[i] = ' '; depth[i] = d; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; depth[i] = d; depth[i + 1] = d; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' '; depth[i] = d; i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; depth[i] = d; depth[i + 1] = d; i += 2; }
      continue;
    }
    if (ch === '"') { stack.push({ kind: 'str' }); depth[i] = d; out[i] = ch; i++; continue; }

    if (ch === '<' && src[i + 1] === '<') {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(src.slice(i, i + 256));
      if (m) {
        // Heredoc bodies are opaque to structure: their braces and any
        // `resource "..." {`-looking lines must not be parsed as code. They
        // are blanked in `code` (newlines kept) and preserved in `text`.
        const id = m[1];
        for (let k = 0; k < m[0].length; k++) { out[i + k] = src[i + k]; depth[i + k] = d; }
        i += m[0].length;
        while (i < n) {
          let eol = src.indexOf('\n', i);
          if (eol === -1) eol = n;
          const line = src.slice(i, eol);
          for (let k = i; k < eol; k++) { out[k] = ' '; depth[k] = d; }
          if (eol < n) { out[eol] = '\n'; depth[eol] = d; }
          i = eol + 1;
          if (line.trim() === id) break;
        }
        continue;
      }
    }

    depth[i] = d;
    if (ch === '{' || ch === '[' || ch === '(') { out[i] = ch; d++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      d = Math.max(0, d - 1);
      depth[i] = d;
      out[i] = ch; i++; continue;
    }
    out[i] = ch; i++;
  }

  return { text: src, code: out.join(''), depth, n };
}

/** Returns a function mapping an absolute character index to a 1-based line. */
function makeLineIndex(text) {
  const src = String(text == null ? '' : text);
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return function lineOf(index) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Line lookup used when no file-wide lineOf is supplied: lines are counted
 * from the start of `src`, which sits at absolute offset `base`. Callers that
 * recurse into block bodies should pass the file-wide lineOf instead, so the
 * reported lines are absolute.
 */
function relativeLines(src, base) {
  const rel = makeLineIndex(src);
  return (absIndex) => rel(absIndex - base);
}

/** Index of the '}' that closes the '{' at `openIdx`, or -1 if unbalanced. */
function matchBrace(scanned, openIdx) {
  const level = scanned.depth[openIdx];
  for (let j = openIdx + 1; j < scanned.n; j++) {
    if (scanned.code[j] === '}' && scanned.depth[j] === level) return j;
  }
  return -1;
}

/**
 * Finds the blocks that start at bracket depth 0 of `text`.
 *
 * Each block: { type, labels, name, start, bodyStart, bodyEnd, end, line, endLine, body }
 *   start/bodyStart/bodyEnd/end are absolute offsets (base + local offset).
 *   line/endLine are 1-based lines computed with `lineOf` (absolute-index aware).
 */
function parseBlocks(text, opts = {}) {
  const base = opts.base || 0;
  const src = String(text == null ? '' : text);
  const lineOf = opts.lineOf || relativeLines(src, base);
  const s = scanHcl(src);
  const blocks = [];
  for (let k = 0; k < s.n; k++) {
    if (s.code[k] !== '{' || s.depth[k] !== 0) continue;
    const lineStart = k === 0 ? 0 : s.code.lastIndexOf('\n', k - 1) + 1;
    const rawHeader = s.code.slice(lineStart, k);
    const header = rawHeader.trim();
    const m = HEADER_RE.exec(header);
    if (!m) continue;
    const identStart = lineStart + (rawHeader.length - rawHeader.trimStart().length);
    const close = matchBrace(s, k);
    if (close === -1) continue;
    const labels = [];
    if (m[2]) {
      const re = new RegExp(LABEL_RE.source, 'g');
      let lm;
      while ((lm = re.exec(m[2])) !== null) labels.push(lm[1] !== undefined ? lm[1] : lm[2]);
    }
    blocks.push({
      type: m[1],
      labels,
      name: labels.length ? labels[labels.length - 1] : null,
      start: base + identStart,
      bodyStart: base + k + 1,
      bodyEnd: base + close,
      end: base + close + 1,
      line: lineOf(base + identStart),
      endLine: lineOf(base + close),
      body: src.slice(k + 1, close),
    });
    k = close;
  }
  return blocks;
}

/**
 * Finds top-level `key = value` attributes of `text` (the body of a block).
 * Each attribute: { name, value, start, end, line }, where value is the source
 * text of the expression (comments already removed), start/end are absolute
 * offsets of the whole `key = value` statement, and line is 1-based.
 * If a name appears twice, the first occurrence wins.
 */
function parseAttributes(text, opts = {}) {
  const base = opts.base || 0;
  const src = String(text == null ? '' : text);
  const lineOf = opts.lineOf || relativeLines(src, base);
  const s = scanHcl(src);
  const attrs = [];
  const seen = new Set();
  let i = 0;
  while (i < s.n) {
    const atLineStart = i === 0 || s.code[i - 1] === '\n';
    if (!atLineStart || s.depth[i] !== 0) { i++; continue; }
    let j = i;
    while (j < s.n && (s.code[j] === ' ' || s.code[j] === '\t')) j++;
    const m = /^([A-Za-z_][\w-]*)[ \t]*=(?!=)/.exec(s.code.slice(j, j + 256));
    if (!m) { i++; continue; }
    const eq = j + m[0].length;
    let e = eq;
    while (e < s.n && !(s.code[e] === '\n' && s.depth[e] === 0)) e++;
    const value = s.code.slice(eq, e).trim();
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      attrs.push({
        name: m[1],
        value,
        start: base + j,
        end: base + e,
        line: lineOf(base + j),
      });
    }
    i = e + 1;
  }
  return attrs;
}

/** Convenience: attributes as a name → attribute map. */
function attributeMap(text, opts) {
  const map = {};
  for (const a of parseAttributes(text, opts)) map[a.name] = a;
  return map;
}

/** Strips one pair of surrounding double quotes; returns null for non-literals. */
function stringLiteral(value) {
  if (typeof value !== 'string') return null;
  const m = /^"((?:[^"\\\n]|\\.)*)"$/.exec(value);
  if (!m) return null;
  if (m[1].includes('${') || m[1].includes('%{')) return null; // interpolated
  return m[1];
}

module.exports = {
  scanHcl,
  makeLineIndex,
  relativeLines,
  matchBrace,
  parseBlocks,
  parseAttributes,
  attributeMap,
  stringLiteral,
};
