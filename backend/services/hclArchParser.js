'use strict';
/**
 * hclArchParser.js
 * ------------------------------------------------------------------------
 * A dependency-free, brace-aware Terraform HCL parser used exclusively by
 * the AWS architecture diagram generator (see architectureMapper.js).
 *
 * This is NOT a full HCL2 grammar implementation. It's a pragmatic
 * structural parser that:
 *   - correctly finds top-level blocks (resource/provider/module/...) even
 *     across multiple lines and nested braces,
 *   - parses attribute assignments (key = value) inside a block body,
 *   - resolves value literals (string/number/bool/list/object),
 *   - and — critically — preserves the raw expression text for anything it
 *     can't fully evaluate (references like `aws_subnet.public.id`,
 *     `var.x`, function calls, ternaries, for-expressions, etc.) so that
 *     the mapper can regex-scan raw expressions for resource references
 *     instead of needing a full expression evaluator.
 *
 * This mirrors the pragmatic regex-based approach already used elsewhere
 * in this codebase (see routes/hcl-explain.js, components/LintPanel.jsx)
 * rather than pulling in a heavy HCL2 grammar dependency.
 */

// ── 1. Comment stripping (string-aware) ────────────────────────────────────
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr = false;
  let strCh = null;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i += 2; continue; }
      if (ch === strCh) inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; out += ch; i++; continue; }
    if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ── 2. Depth-aware scan helpers (string-aware) ─────────────────────────────
/**
 * Given src and a start index pointing at an opening brace/bracket/paren,
 * returns the index just past the matching closing char.
 */
function scanMatching(src, start, openCh, closeCh) {
  let depth = 0;
  let i = start;
  const n = src.length;
  let inStr = false;
  let strCh = null;
  while (i < n) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === strCh) inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; i++; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

/** Scans a double-quoted string starting at s[start]==='"'. Returns index just past the closing quote. */
function scanString(s, start) {
  let i = start + 1;
  const n = s.length;
  while (i < n) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return n;
}

// ── 3. Top-level block splitter ────────────────────────────────────────────
/**
 * Splits `src` into top-level blocks of the form `header { body }`.
 * Returns [{ header: 'resource "aws_vpc" "main"', body: '...' }, ...]
 */
function findBlocks(src) {
  const blocks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    const headerStart = i;
    let inStr = false, strCh = null;
    while (i < n && src[i] !== '{') {
      const ch = src[i];
      if (inStr) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === strCh) inStr = false;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; i++; continue; }
      i++;
    }
    if (i >= n) break; // trailing non-block content — ignore
    const header = src.slice(headerStart, i).trim();
    const bodyStart = i + 1;
    const afterClose = scanMatching(src, i, '{', '}');
    const body = src.slice(bodyStart, afterClose - 1);
    if (header) blocks.push({ header, body });
    i = afterClose;
  }
  return blocks;
}

function parseHeader(header) {
  const labels = [...header.matchAll(/"([^"]*)"/g)].map(m => m[1]);
  const blockType = header.split(/[\s"]/)[0].trim();
  return { blockType, labels };
}

// ── 4. Body (attribute) parser ─────────────────────────────────────────────
/**
 * Parses a block body into a map of attributes.
 * Repeated keys (e.g. multiple `ingress { ... }` blocks) become arrays.
 */
function parseBody(body) {
  const attrs = {};
  let i = 0;
  const n = body.length;

  const skipWs = () => { while (i < n && /\s/.test(body[i])) i++; };

  const set = (key, val) => {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      if (Array.isArray(attrs[key])) attrs[key].push(val);
      else attrs[key] = [attrs[key], val];
    } else {
      attrs[key] = val;
    }
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;

    // Skip stray commas/newline artifacts
    if (body[i] === ',' || body[i] === ';') { i++; continue; }

    // Read key: bare identifier or quoted string
    let key;
    if (body[i] === '"') {
      const start = i;
      i = scanString(body, i);
      // scanMatching expects openCh!==closeCh generally, but works fine when equal
      // because depth toggles 1 then back to 0 — safe here.
      key = body.slice(start + 1, i - 1);
    } else {
      const start = i;
      while (i < n && /[A-Za-z0-9_.\-]/.test(body[i])) i++;
      key = body.slice(start, i);
    }
    if (!key) { i++; continue; }

    skipWs();

    if (body[i] === '=') {
      // attribute assignment
      i++;
      skipWs();
      const { value, next } = parseValue(body, i);
      set(key, value);
      i = next;
    } else {
      // nested block: possibly more quoted labels, then '{'
      const blockLabels = [];
      while (i < n && body[i] === '"') {
        const start = i;
        i = scanString(body, i);
        blockLabels.push(body.slice(start + 1, i - 1));
        skipWs();
      }
      if (body[i] === '{') {
        const bodyStart = i + 1;
        const after = scanMatching(body, i, '{', '}');
        const innerBody = body.slice(bodyStart, after - 1);
        set(key, { type: 'block', labels: blockLabels, attrs: parseBody(innerBody) });
        i = after;
      } else {
        // Malformed / unsupported construct — skip to next newline to avoid infinite loop
        while (i < n && body[i] !== '\n') i++;
      }
    }
  }

  return attrs;
}

/**
 * Parses a single value starting at index i. Returns { value, next }.
 */
function parseValue(body, i) {
  const n = body.length;
  const ch = body[i];

  if (ch === '"') {
    const start = i;
    const after = scanString(body, i);
    const raw = body.slice(start + 1, after - 1);
    return { value: { type: 'string', value: unescapeStr(raw) }, next: after };
  }

  if (ch === '[') {
    const after = scanMatching(body, i, '[', ']');
    const inner = body.slice(i + 1, after - 1);
    const items = splitTopLevel(inner, ',').map(chunk => {
      const trimmed = chunk.trim();
      if (!trimmed) return null;
      return parseValue(trimmed, 0).value;
    }).filter(Boolean);
    return { value: { type: 'list', items }, next: after };
  }

  if (ch === '{') {
    const after = scanMatching(body, i, '{', '}');
    const inner = body.slice(i + 1, after - 1);
    return { value: { type: 'object', attrs: parseBody(inner) }, next: after };
  }

  // Bare expression: read until newline at depth 0 (paren/bracket/brace-aware),
  // OR a top-level comma (list-context — callers pre-split on commas so this
  // mainly matters for object/list nesting safety), OR the start of a new
  // `identifier = ` assignment at depth 0. That last case shouldn't occur in
  // strictly valid HCL (each attribute belongs on its own line) but we stay
  // defensive about it: several attributes crammed onto one line without a
  // newline between them (e.g. hand-compacted or minified HCL) would
  // otherwise silently swallow every attribute after the first into one
  // garbled expression, corrupting fields the mapper depends on (subnets,
  // internal, etc.) even though nothing looked wrong at parse time.
  const NEW_ASSIGNMENT_RE = /^[ \t]+[A-Za-z_][A-Za-z0-9_.\-]*[ \t]*=(?!=)/;
  let j = i;
  let depth = 0;
  let inStr = false, strCh = null;
  while (j < n) {
    const c = body[j];
    if (inStr) {
      if (c === '\\') { j += 2; continue; }
      if (c === strCh) inStr = false;
      j++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; j++; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; j++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // end of expression, unmatched closer belongs to caller
      depth--;
      j++;
      continue;
    }
    if (c === '\n' && depth === 0) break;
    if (c === ',' && depth === 0) break;
    if (depth === 0 && (c === ' ' || c === '\t') && NEW_ASSIGNMENT_RE.test(body.slice(j, j + 60))) break;
    j++;
  }
  const raw = body.slice(i, j).trim();
  if (/^(true|false)$/i.test(raw)) {
    return { value: { type: 'bool', value: /^true$/i.test(raw) }, next: j };
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return { value: { type: 'number', value: parseFloat(raw) }, next: j };
  }
  return { value: { type: 'expr', raw }, next: j };
}

function unescapeStr(s) {
  return s.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
}

/** Splits `s` on `sep` only at bracket/brace/paren/string depth 0. */
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let inStr = false, strCh = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// ── 5. Resource expansion (count / for_each) ────────────────────────────────
// Terraform's `count = N` / `for_each = <set|map>` turn ONE resource block
// into N actual infrastructure resources — a `count`-based pair of public/
// private subnets is extremely common in real Terraform and, unexpanded,
// looks like a single subnet to everything downstream (wrong resource
// count, and no way to tell which public/private instances share an AZ).
// This expands each block into per-instance clones with `count.index` /
// `each.key` / `each.value` substituted into any expression or string that
// references them, so the rest of the pipeline sees the same shape it
// would from N separately-written resource blocks.
const TOKEN_RE = {
  countIndex: /\bcount\.index\b/g,
  eachKey: /\beach\.key\b/g,
  eachValue: /\beach\.value\b/g,
};

function substituteInNode(node, subst) {
  if (!node) return node;
  if (node.type === 'expr') {
    let raw = node.raw;
    if (subst.countIndex) raw = raw.replace(TOKEN_RE.countIndex, subst.countIndex.expr);
    if (subst.eachKey) raw = raw.replace(TOKEN_RE.eachKey, subst.eachKey.expr);
    if (subst.eachValue) raw = raw.replace(TOKEN_RE.eachValue, subst.eachValue.expr);
    if (raw === node.raw) return node;
    // If substitution reduced the whole expression to a pure literal (very
    // common: `availability_zone = each.value` becomes `"us-east-1a"`),
    // re-classify it so downstream literal checks (asString/asNumber/
    // asBool) recognize it instead of treating it as an opaque expression.
    const trimmed = raw.trim();
    const strMatch = trimmed.match(/^"([^"]*)"$/);
    if (strMatch) return { type: 'string', value: strMatch[1] };
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { type: 'number', value: parseFloat(trimmed) };
    if (/^(true|false)$/i.test(trimmed)) return { type: 'bool', value: /^true$/i.test(trimmed) };
    return { type: 'expr', raw };
  }
  if (node.type === 'string') {
    let value = node.value;
    if (subst.countIndex) value = value.replace(TOKEN_RE.countIndex, subst.countIndex.str);
    if (subst.eachKey) value = value.replace(TOKEN_RE.eachKey, subst.eachKey.str);
    if (subst.eachValue) value = value.replace(TOKEN_RE.eachValue, subst.eachValue.str);
    // Collapse trivial `${<literal>}` wrappers left behind by the token
    // substitution above (e.g. "public-${count.index}" → "public-${0}" →
    // "public-0", or "web-${each.key}" → "web-${a}" → "web-a") so display
    // names read naturally instead of showing stray interpolation syntax.
    value = value.replace(/\$\{\s*"?([A-Za-z0-9_.\-]*)"?\s*\}/g, '$1');
    return value === node.value ? node : { type: 'string', value };
  }
  if (node.type === 'list') {
    return { type: 'list', items: node.items.map(i => substituteInNode(i, subst)) };
  }
  if (node.type === 'object' || node.type === 'block') {
    const attrs = {};
    for (const [k, v] of Object.entries(node.attrs)) {
      attrs[k] = Array.isArray(v) ? v.map(x => substituteInNode(x, subst)) : substituteInNode(v, subst);
    }
    return node.type === 'block' ? { type: 'block', labels: node.labels, attrs } : { type: 'object', attrs };
  }
  return node; // number / bool — no tokens possible
}

function substituteInAttrs(attrs, subst) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = Array.isArray(v) ? v.map(x => substituteInNode(x, subst)) : substituteInNode(v, subst);
  }
  return out;
}

/** Resolves `var.<name>` to its literal default, one level deep (no recursive var chains). */
function resolveVarLiteral(varName, variablesByName) {
  const v = variablesByName[varName];
  if (!v || !v.default) return null;
  return v.default;
}

/** Best-effort resolution of a `count`/`for_each` value node to a literal (number, list, or object). */
function resolveLiteralNode(node, variablesByName) {
  if (!node) return null;
  if (['number', 'string', 'bool', 'list', 'object'].includes(node.type)) return node;
  if (node.type === 'expr') {
    const varMatch = node.raw.trim().match(/^var\.([A-Za-z0-9_-]+)$/);
    if (varMatch) return resolveVarLiteral(varMatch[1], variablesByName);
    const tosetMatch = node.raw.trim().match(/^toset\(\s*(\[[\s\S]*\])\s*\)$/);
    if (tosetMatch) {
      try { return parseValue(tosetMatch[1], 0).value; } catch { return null; }
    }
  }
  return null;
}

/** Turns a resolved for_each collection (list or object) into [{keyExpr,keyStr,valueExpr,valueStr}]. */
function forEachEntries(collection) {
  if (!collection) return null;
  if (collection.type === 'list') {
    return collection.items
      .filter(i => i && i.type === 'string')
      .map(i => ({ keyExpr: JSON.stringify(i.value), keyStr: i.value, valueExpr: JSON.stringify(i.value), valueStr: i.value }));
  }
  if (collection.type === 'object') {
    return Object.entries(collection.attrs)
      .map(([k, v]) => {
        const valNode = Array.isArray(v) ? v[0] : v;
        const valStr = valNode && valNode.type === 'string' ? valNode.value : k;
        return { keyExpr: JSON.stringify(k), keyStr: k, valueExpr: JSON.stringify(valStr), valueStr: valStr };
      });
  }
  return null;
}

const MAX_EXPANSION = 300; // sanity bound — no runaway expansion on a bad literal

function expandResources(resources, variablesByName, parseWarnings) {
  const out = [];
  for (const r of resources) {
    const countNode = r.attrs.count;
    const forEachNode = r.attrs.for_each;

    if (countNode) {
      const literal = resolveLiteralNode(countNode, variablesByName);
      if (literal && literal.type === 'number' && Number.isInteger(literal.value) && literal.value >= 0 && literal.value <= MAX_EXPANSION) {
        for (let i = 0; i < literal.value; i++) {
          const attrs = substituteInAttrs(r.attrs, { countIndex: { expr: String(i), str: String(i) } });
          delete attrs.count;
          out.push({ ...r, key: `${r.type}.${r.name}[${i}]`, attrs, index: i, baseKey: r.key });
        }
      } else {
        parseWarnings.push(`Resource "${r.key}" has a "count" that couldn't be resolved to a literal number — showing one representative instance instead of expanding it.`);
        const attrs = { ...r.attrs };
        delete attrs.count;
        out.push({ ...r, attrs });
      }
      continue;
    }

    if (forEachNode) {
      const literal = resolveLiteralNode(forEachNode, variablesByName);
      const entries = literal ? forEachEntries(literal) : null;
      if (entries && entries.length && entries.length <= MAX_EXPANSION) {
        entries.forEach(({ keyExpr, keyStr, valueExpr, valueStr }) => {
          const attrs = substituteInAttrs(r.attrs, {
            eachKey: { expr: keyExpr, str: keyStr },
            eachValue: { expr: valueExpr, str: valueStr },
          });
          delete attrs.for_each;
          out.push({ ...r, key: `${r.type}.${r.name}["${keyStr}"]`, attrs, index: keyStr, baseKey: r.key });
        });
      } else {
        parseWarnings.push(`Resource "${r.key}" has a "for_each" that couldn't be resolved to a literal set/map — showing one representative instance instead of expanding it.`);
        const attrs = { ...r.attrs };
        delete attrs.for_each;
        out.push({ ...r, attrs });
      }
      continue;
    }

    out.push(r);
  }
  return out;
}

// ── 6. Public API ───────────────────────────────────────────────────────────
/**
 * Parses one or more concatenated Terraform source files into a flat model:
 *   { resources: [{type,name,key,attrs}], providers: [...], modules: [...],
 *     dataSources: [...], parseWarnings: [...] }
 */
function parseHclSources(sources) {
  // sources: [{ filename, content }]
  const resources = [];
  const providers = [];
  const modules = [];
  const dataSources = [];
  const variables = [];
  const parseWarnings = [];

  for (const src of sources) {
    let cleaned;
    try {
      cleaned = stripComments(src.content || '');
    } catch (e) {
      parseWarnings.push(`Could not read ${src.filename || 'input'}: ${e.message}`);
      continue;
    }

    let blocks;
    try {
      blocks = findBlocks(cleaned);
    } catch (e) {
      parseWarnings.push(`Could not parse ${src.filename || 'input'}: ${e.message}`);
      continue;
    }

    for (const { header, body } of blocks) {
      let blockType, labels;
      try {
        ({ blockType, labels } = parseHeader(header));
      } catch {
        continue;
      }

      if (blockType === 'resource' && labels.length >= 2) {
        const [resType, resName] = labels;
        let attrs = {};
        try { attrs = parseBody(body); } catch (e) {
          parseWarnings.push(`Could not parse resource "${resType}" "${resName}": ${e.message}`);
        }
        resources.push({
          type: resType,
          name: resName,
          key: `${resType}.${resName}`,
          attrs,
          file: src.filename || null,
        });
      } else if (blockType === 'provider' && labels.length >= 1) {
        let attrs = {};
        try { attrs = parseBody(body); } catch {}
        providers.push({ name: labels[0], attrs });
      } else if (blockType === 'module' && labels.length >= 1) {
        let attrs = {};
        try { attrs = parseBody(body); } catch {}
        modules.push({ name: labels[0], attrs });
      } else if (blockType === 'data' && labels.length >= 2) {
        let attrs = {};
        try { attrs = parseBody(body); } catch {}
        dataSources.push({ type: labels[0], name: labels[1], key: `data.${labels[0]}.${labels[1]}`, attrs });
      } else if (blockType === 'variable' && labels.length >= 1) {
        let attrs = {};
        try { attrs = parseBody(body); } catch {}
        variables.push({ name: labels[0], default: attrs.default || null });
      }
      // output / locals / terraform blocks: intentionally not needed for
      // architecture inference — skipped.
    }
  }

  const variablesByName = {};
  variables.forEach(v => { variablesByName[v.name] = v; });

  const expandedResources = expandResources(resources, variablesByName, parseWarnings);

  return { resources: expandedResources, providers, modules, dataSources, variables: variablesByName, parseWarnings };
}

module.exports = {
  parseHclSources,
  resolveVarLiteral,
  parseValue,
  // exported for unit testing
  _internal: { stripComments, findBlocks, parseHeader, parseBody, splitTopLevel, expandResources },
};
