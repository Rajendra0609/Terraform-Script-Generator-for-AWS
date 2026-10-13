'use strict';
/**
 * Terraform module analyzer.
 *
 * Given the .tf files that make up one module, produces:
 *   - an inventory: variables (inputs), outputs, locals, resources, data
 *     sources, module calls, providers and version constraints
 *   - a dependency graph (who references whom) with cycle detection
 *   - issues: undeclared references, unused inputs, missing descriptions or
 *     types, sensitive values that leak through outputs, unpinned providers
 *     and module sources, hard-coded secrets, and so on
 *   - human-readable documentation (markdown) and a Mermaid flowchart
 *
 * Built on services/hclScan.js, so comments and strings never produce phantom
 * references and every issue carries the file and line it refers to. This is
 * a static read of the source; it does not run `terraform` and does not resolve
 * module sources or evaluate expressions.
 */
const {
  scanHcl,
  makeLineIndex,
  parseBlocks,
  parseAttributes,
  stringLiteral,
} = require('./hclScan');

const RESERVED_MODULE_ARGS = new Set(['source', 'version', 'count', 'for_each', 'providers', 'depends_on']);
const SECRET_NAME_RE = /(^|_)(password|passwd|secret|token|api_?key|private_?key|access_?key)(_|$)/i;
const SECRET_NAME_EXCLUDE_RE = /_(id|arn|name|version|arn)$/i;
const REGISTRY_SOURCE_RE = /^(?:[a-z0-9.-]+\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const ISSUE_SEVERITY = { error: 'error', warning: 'warning', info: 'info' };

function isSecretName(name) {
  return SECRET_NAME_RE.test(name) && !SECRET_NAME_EXCLUDE_RE.test(name);
}

/**
 * Every reference in `text` as { ref, line } where line is 1-based relative to
 * the start of `text`. Each reference id is reported once, at its first use.
 */
function extractReferenceSites(text, providerPrefixes) {
  const code = scanHcl(text).code;
  const lineAt = makeLineIndex(code);
  const sites = new Map();
  const add = (ref, index) => { if (!sites.has(ref)) sites.set(ref, lineAt(index)); };
  let m;
  const varRe = /\bvar\.([A-Za-z_][\w-]*)/g;
  while ((m = varRe.exec(code)) !== null) add(`var.${m[1]}`, m.index);
  const localRe = /\blocal\.([A-Za-z_][\w-]*)/g;
  while ((m = localRe.exec(code)) !== null) add(`local.${m[1]}`, m.index);
  const moduleRe = /\bmodule\.([A-Za-z_][\w-]*)/g;
  while ((m = moduleRe.exec(code)) !== null) add(`module.${m[1]}`, m.index);
  const dataRe = /(?<![\w.])data\.([a-z0-9_]+)\.([A-Za-z_][\w-]*)/g;
  while ((m = dataRe.exec(code)) !== null) add(`data.${m[1]}.${m[2]}`, m.index);
  const resRe = /(?<![\w.])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\.([A-Za-z_][\w-]*)/g;
  while ((m = resRe.exec(code)) !== null) {
    const type = m[1];
    if (type.startsWith('data_') || type === 'each' || type === 'count' || type === 'self') continue;
    if (providerPrefixes.some((p) => type.startsWith(`${p}_`))) add(`resource.${type}.${m[2]}`, m.index);
  }
  return [...sites.entries()].map(([ref, line]) => ({ ref, line }));
}

/** Collects every `var.x`, `local.x`, `module.x`, `data.t.n` and `<provider>_<type>.<name>` reference in `text`. */
function extractReferences(text, providerPrefixes) {
  return extractReferenceSites(text, providerPrefixes).map((s) => s.ref);
}

/** Reads one file into a list of positioned blocks. */
function readFile(file) {
  const content = String(file.content == null ? '' : file.content);
  const lineOf = makeLineIndex(content);
  const blocks = parseBlocks(content, { lineOf });
  return { path: file.path, content, lineOf, blocks };
}

function attrsOfBlock(file, block) {
  const map = {};
  for (const a of parseAttributes(file.content.slice(block.bodyStart, block.bodyEnd), {
    base: block.bodyStart,
    lineOf: file.lineOf,
  })) map[a.name] = a;
  return map;
}

function childrenOfBlock(file, block, type) {
  return parseBlocks(file.content.slice(block.bodyStart, block.bodyEnd), {
    base: block.bodyStart,
    lineOf: file.lineOf,
  }).filter((b) => b.type === type);
}

function bodyText(file, block) {
  return file.content.slice(block.bodyStart, block.bodyEnd);
}

function boolLiteral(attr) {
  if (!attr) return false;
  return attr.value === 'true';
}

// ─── analysis ─────────────────────────────────────────────────────────────────

function analyzeModule(files, options = {}) {
  const parsed = (Array.isArray(files) ? files : []).map(readFile);

  // Provider local names decide what counts as a resource reference.
  const providerNames = new Set(['aws']);
  const terraformInfo = { requiredVersion: null, requiredProviders: [], file: null, line: null };
  for (const f of parsed) {
    for (const b of f.blocks) {
      if (b.type === 'terraform') {
        const attrs = attrsOfBlock(f, b);
        if (attrs.required_version) {
          terraformInfo.requiredVersion = stringLiteral(attrs.required_version.value) ?? attrs.required_version.value;
          terraformInfo.file = f.path; terraformInfo.line = attrs.required_version.line;
        }
        for (const rp of childrenOfBlock(f, b, 'required_providers')) {
          for (const a of parseAttributes(bodyText(f, rp), { base: rp.bodyStart, lineOf: f.lineOf })) {
            providerNames.add(a.name);
            const inner = parseAttributes(a.value.replace(/^\{/, '').replace(/\}$/, ''));
            const inf = {};
            for (const x of inner) inf[x.name] = stringLiteral(x.value) ?? x.value;
            terraformInfo.requiredProviders.push({
              name: a.name, source: inf.source || null, version: inf.version || null,
              file: f.path, line: a.line,
            });
          }
        }
      }
      if (b.type === 'provider' && b.name) providerNames.add(b.name);
    }
  }
  const providerPrefixes = [...providerNames];

  const variables = [];
  const outputs = [];
  const locals = [];
  const resources = [];
  const dataSources = [];
  const moduleCalls = [];
  const providers = [];
  const nodes = new Map();      // id -> { id, kind, label, file, line }
  const owners = [];            // { id, body(text), file, line } — things that reference others
  const issues = [];

  const addIssue = (rule, severity, file, line, subject, message, suggestion) =>
    issues.push({ rule, severity, file, line, subject, message, suggestion });

  for (const f of parsed) {
    for (const b of f.blocks) {
      const attrs = attrsOfBlock(f, b);
      if (b.type === 'variable' && b.name) {
        const v = {
          name: b.name, file: f.path, line: b.line,
          type: attrs.type ? attrs.type.value : null,
          hasDefault: Boolean(attrs.default),
          default: attrs.default ? attrs.default.value : null,
          description: attrs.description ? stringLiteral(attrs.description.value) : null,
          sensitive: boolLiteral(attrs.sensitive),
          nullable: attrs.nullable ? attrs.nullable.value : null,
          validations: childrenOfBlock(f, b, 'validation').length,
        };
        variables.push(v);
        const id = `var.${b.name}`;
        nodes.set(id, { id, kind: 'variable', label: b.name, file: f.path, line: b.line });
        if (!v.description) addIssue('VAR_NO_DESCRIPTION', 'warning', f.path, b.line, id,
          `Variable "${b.name}" has no description.`,
          `Add description = "…" explaining what the input controls.`);
        if (!v.type) addIssue('VAR_NO_TYPE', 'warning', f.path, b.line, id,
          `Variable "${b.name}" has no type constraint.`,
          `Add type = string (or the appropriate type) so bad input fails early.`);
        if (isSecretName(b.name) && !v.sensitive) addIssue('VAR_SECRET_NOT_SENSITIVE', 'warning', f.path, b.line, id,
          `Variable "${b.name}" looks like a secret but is not marked sensitive.`,
          `Set sensitive = true so Terraform redacts it from plan output and logs.`);
        const literalDefault = attrs.default ? stringLiteral(attrs.default.value) : null;
        if (isSecretName(b.name) && literalDefault && literalDefault.length > 0) {
          addIssue('VAR_SECRET_DEFAULT', 'error', f.path, attrs.default.line, id,
            `Variable "${b.name}" has a literal default value that looks like a credential.`,
            `Remove the default so the value must be supplied at run time (or from a secret store).`);
        }
      } else if (b.type === 'output' && b.name) {
        const id = `output.${b.name}`;
        const o = {
          name: b.name, file: f.path, line: b.line,
          description: attrs.description ? stringLiteral(attrs.description.value) : null,
          sensitive: boolLiteral(attrs.sensitive),
          value: attrs.value ? attrs.value.value : '',
        };
        outputs.push(o);
        nodes.set(id, { id, kind: 'output', label: b.name, file: f.path, line: b.line });
        owners.push({ id, text: bodyText(f, b), file: f.path, line: b.line });
        if (!o.description) addIssue('OUTPUT_NO_DESCRIPTION', 'info', f.path, b.line, id,
          `Output "${b.name}" has no description.`, `Add description = "…" so consumers know what the value means.`);
        if (isSecretName(b.name) && !o.sensitive) addIssue('OUTPUT_SECRET_NOT_SENSITIVE', 'warning', f.path, b.line, id,
          `Output "${b.name}" looks like a secret but is not marked sensitive.`,
          `Set sensitive = true, or stop exporting the secret.`);
      } else if (b.type === 'locals') {
        for (const a of parseAttributes(bodyText(f, b), { base: b.bodyStart, lineOf: f.lineOf })) {
          const id = `local.${a.name}`;
          locals.push({ name: a.name, file: f.path, line: a.line, value: a.value });
          nodes.set(id, { id, kind: 'local', label: a.name, file: f.path, line: a.line });
          owners.push({ id, text: a.value, file: f.path, line: a.line });
        }
      } else if (b.type === 'resource' && b.labels.length === 2) {
        const id = `resource.${b.labels[0]}.${b.labels[1]}`;
        resources.push({ type: b.labels[0], name: b.labels[1], address: `${b.labels[0]}.${b.labels[1]}`, file: f.path, line: b.line });
        nodes.set(id, { id, kind: 'resource', label: `${b.labels[0]}.${b.labels[1]}`, file: f.path, line: b.line });
        owners.push({ id, text: bodyText(f, b), file: f.path, line: b.line });
      } else if (b.type === 'data' && b.labels.length === 2) {
        const id = `data.${b.labels[0]}.${b.labels[1]}`;
        dataSources.push({ type: b.labels[0], name: b.labels[1], address: id, file: f.path, line: b.line });
        nodes.set(id, { id, kind: 'data', label: id, file: f.path, line: b.line });
        owners.push({ id, text: bodyText(f, b), file: f.path, line: b.line });
      } else if (b.type === 'module' && b.name) {
        const id = `module.${b.name}`;
        const inputs = Object.keys(attrs).filter((k) => !RESERVED_MODULE_ARGS.has(k));
        const source = attrs.source ? stringLiteral(attrs.source.value) : null;
        const version = attrs.version ? stringLiteral(attrs.version.value) : null;
        moduleCalls.push({ name: b.name, source, version, inputs, file: f.path, line: b.line });
        nodes.set(id, { id, kind: 'module', label: b.name, file: f.path, line: b.line });
        owners.push({ id, text: bodyText(f, b), file: f.path, line: b.line });
        for (const key of inputs) {
          const a = attrs[key];
          if (isSecretName(key) && stringLiteral(a.value) && stringLiteral(a.value).length > 0) {
            addIssue('MODULE_INPUT_HARDCODED_SECRET', 'error', f.path, a.line, id,
              `Module "${b.name}" is passed a literal value for "${key}".`,
              `Pass a sensitive variable or a secret-store lookup instead of a literal.`);
          }
        }
        if (source) {
          const isLocal = source.startsWith('./') || source.startsWith('../');
          const isGit = /^(git::|github\.com\/|git@|https?:\/\/.*\.git)/.test(source);
          if (!isLocal && isGit && !/[?&]ref=/.test(source)) {
            addIssue('MODULE_SOURCE_UNPINNED', 'warning', f.path, b.line, id,
              `Module "${b.name}" git source is not pinned to a ref.`,
              `Append ?ref=<tag-or-commit> to the source so the module cannot change underneath you.`);
          }
          if (!isLocal && !isGit && REGISTRY_SOURCE_RE.test(source) && !version) {
            addIssue('MODULE_SOURCE_UNPINNED', 'warning', f.path, b.line, id,
              `Module "${b.name}" uses a registry source with no version constraint.`,
              `Add version = "~> x.y" so upgrades are deliberate.`);
          }
        }
      } else if (b.type === 'provider' && b.name) {
        providers.push({ name: b.name, alias: attrs.alias ? stringLiteral(attrs.alias.value) : null, file: f.path, line: b.line });
      }
    }
  }

  // ── references and graph ───────────────────────────────────────────────────
  const declared = new Set(nodes.keys());
  const edges = [];
  const referenced = new Set();
  for (const owner of owners) {
    for (const site of extractReferenceSites(owner.text, providerPrefixes)) {
      const ref = site.ref;
      // owner.line is the line where the owner's text starts; site.line is relative to it.
      const refLine = owner.line + site.line - 1;
      referenced.add(ref);
      if (!declared.has(ref)) {
        const [kind] = ref.split('.');
        const rule = { var: 'VAR_UNDECLARED', local: 'LOCAL_UNDECLARED', module: 'MODULE_UNDECLARED',
          data: 'DATA_UNDECLARED', resource: 'RESOURCE_UNDECLARED' }[kind] || 'REFERENCE_UNDECLARED';
        const label = ref.replace(/^resource\./, '');
        addIssue(rule, 'error', owner.file, refLine, owner.id,
          `${owner.id} references ${label}, which is not declared in this module.`,
          kind === 'var' ? `Declare variable "${label.slice(4)}" or fix the reference.`
            : `Check the spelling of ${label}; references cannot reach into a parent or child module.`);
        continue;
      }
      edges.push({ from: owner.id, to: ref, kind: 'reference' });
    }
  }

  // Unused inputs and locals.
  for (const v of variables) {
    if (!referenced.has(`var.${v.name}`)) {
      addIssue('VAR_UNUSED', 'warning', v.file, v.line, `var.${v.name}`,
        `Variable "${v.name}" is declared but never used.`,
        `Remove it, or wire it into a resource. Unused inputs confuse callers.`);
    }
  }
  for (const l of locals) {
    if (!referenced.has(`local.${l.name}`)) {
      addIssue('LOCAL_UNUSED', 'info', l.file, l.line, `local.${l.name}`,
        `Local "${l.name}" is never used.`, `Delete it or use it.`);
    }
  }

  // Outputs that expose sensitive inputs without being marked sensitive.
  const sensitiveVars = new Set(variables.filter((v) => v.sensitive).map((v) => v.name));
  for (const o of outputs) {
    const usesSensitive = [...sensitiveVars].some((name) => new RegExp(`\\bvar\\.${name}\\b`).test(o.value));
    if (usesSensitive && !o.sensitive) {
      addIssue('OUTPUT_SENSITIVE_LEAK', 'error', o.file, o.line, `output.${o.name}`,
        `Output "${o.name}" exposes a sensitive variable but is not marked sensitive.`,
        `Set sensitive = true on the output. Terraform rejects the plan without it.`);
    }
  }

  // Dependency cycles.
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const cycles = findCycles(adj);
  for (const cycle of cycles) {
    const first = cycle[0];
    const node = nodes.get(first);
    addIssue('DEPENDENCY_CYCLE', 'error', node?.file || null, node?.line || null, first,
      `Dependency cycle: ${[...cycle, cycle[0]].join(' → ')}`,
      `Break the cycle by moving one of the references into a separate resource or a depends_on-free design.`);
  }

  // Provider version constraints.
  for (const p of terraformInfo.requiredProviders) {
    if (!p.version) addIssue('PROVIDER_VERSION_UNPINNED', 'warning', p.file, p.line, `provider.${p.name}`,
      `Provider "${p.name}" has no version constraint.`,
      `Add version = "~> 5.0" (or your tested major) under required_providers.`);
  }
  if (!terraformInfo.requiredVersion) {
    addIssue('TERRAFORM_VERSION_MISSING', 'info', null, null, 'terraform',
      'No terraform { required_version = … } constraint is declared.',
      'Pin the Terraform CLI version this module is tested with.');
  }

  issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) ||
    String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));

  const graph = {
    nodes: [...nodes.values()],
    edges,
  };
  const summary = {
    files: parsed.length,
    variables: variables.length,
    outputs: outputs.length,
    locals: locals.length,
    resources: resources.length,
    dataSources: dataSources.length,
    moduleCalls: moduleCalls.length,
    providers: providers.length,
    dependencies: edges.length,
    cycles: cycles.length,
    issues: {
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
  };

  return {
    summary,
    variables, outputs, locals, resources, dataSources, moduleCalls, providers,
    terraform: terraformInfo,
    graph,
    issues,
    ...(options.includeFiles ? { files: parsed.map((f) => f.path) } : {}),
  };
}

function severityRank(s) {
  return { error: 0, warning: 1, info: 2 }[s] ?? 3;
}

/**
 * Finds elementary cycles (one per back-edge) in a directed graph given as an
 * adjacency map. Returns arrays of node ids in cycle order.
 */
function findCycles(adj) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();
  function visit(u) {
    color.set(u, GREY);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      const c = color.get(v) ?? WHITE;
      if (c === GREY) {
        const cycle = stack.slice(stack.indexOf(v));
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if (c === WHITE) {
        visit(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  }
  for (const u of adj.keys()) if ((color.get(u) ?? WHITE) === WHITE) visit(u);
  return cycles;
}

/** Markdown reference for a module: inputs, outputs, resources, module calls. */
function toMarkdown(result, { title = 'Module' } = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${title}`, ''];
  lines.push(`Files analysed: ${result.summary.files}. Issues: ${result.summary.issues.error} error, ` +
    `${result.summary.issues.warning} warning, ${result.summary.issues.info} info.`, '');
  lines.push('## Inputs', '');
  if (result.variables.length === 0) lines.push('_No input variables._', '');
  else {
    lines.push('| Name | Type | Required | Sensitive | Description |', '|---|---|---|---|---|');
    for (const v of result.variables) {
      lines.push(`| \`${esc(v.name)}\` | ${esc(v.type || 'any')} | ${v.hasDefault ? 'no' : 'yes'} | ${v.sensitive ? 'yes' : 'no'} | ${esc(v.description || '—')} |`);
    }
    lines.push('');
  }
  lines.push('## Outputs', '');
  if (result.outputs.length === 0) lines.push('_No outputs._', '');
  else {
    lines.push('| Name | Sensitive | Description |', '|---|---|---|');
    for (const o of result.outputs) lines.push(`| \`${esc(o.name)}\` | ${o.sensitive ? 'yes' : 'no'} | ${esc(o.description || '—')} |`);
    lines.push('');
  }
  lines.push('## Resources', '');
  if (result.resources.length === 0) lines.push('_No resources._', '');
  else for (const r of result.resources) lines.push(`- \`${r.address}\` (${r.file}:${r.line})`);
  if (result.resources.length) lines.push('');
  if (result.dataSources.length) {
    lines.push('## Data sources', '');
    for (const d of result.dataSources) lines.push(`- \`${d.address}\` (${d.file}:${d.line})`);
    lines.push('');
  }
  if (result.moduleCalls.length) {
    lines.push('## Module calls', '');
    for (const m of result.moduleCalls) {
      lines.push(`- \`${m.name}\` → ${m.source || 'unknown source'}${m.version ? ` @ ${m.version}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Providers and versions', '');
  if (result.terraform.requiredVersion) lines.push(`- Terraform: \`${result.terraform.requiredVersion}\``);
  for (const p of result.terraform.requiredProviders) {
    lines.push(`- Provider \`${p.name}\`: source \`${p.source || '—'}\`, version \`${p.version || 'unpinned'}\``);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Mermaid flowchart of the dependency graph (renders on GitHub and in most Markdown viewers).
 * An arrow A --> B means "A depends on B".
 */
function toMermaid(result) {
  const safe = (id) => id.replace(/[^A-Za-z0-9_]/g, '_');
  const lines = ['flowchart LR'];
  for (const n of result.graph.nodes) {
    const shape = n.kind === 'variable' ? `([${n.label}])` : n.kind === 'output' ? `>${n.label}]` : `[${n.label}]`;
    lines.push(`  ${safe(n.id)}${shape}`);
  }
  for (const e of result.graph.edges) lines.push(`  ${safe(e.from)} --> ${safe(e.to)}`);
  return lines.join('\n');
}

module.exports = {
  analyzeModule,
  extractReferences,
  extractReferenceSites,
  findCycles,
  toMarkdown,
  toMermaid,
  isSecretName,
};
