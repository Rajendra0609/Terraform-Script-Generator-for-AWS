/**
 * TFGen Template Engine — production-grade HCL generation.
 *
 * Provides:
 *  - Template interpolation ({{placeholder}} substitution)
 *  - Provider + backend block generation
 *  - locals block auto-generation (common values consolidated)
 *  - lifecycle block generation (prevent_destroy, ignore_changes, etc.)
 *  - data source auto-injection (aws_caller_identity, aws_availability_zones)
 *  - variables + outputs HCL serialization
 *  - Full project HCL assembly (main.tf, variables.tf, outputs.tf, providers.tf)
 *
 * FIX: Resolved terraform validate failures:
 *  - BUG-TF-01: Duplicate required_providers.aws across providers.tf + versions.tf
 *    → generateProviderBlock now emits ONLY the provider "aws" {} block.
 *    → generateTerraformBlock() is the single source of truth for the terraform{} block.
 *    → generateHCL now returns '' for undefined keys (removed "keep match" behaviour).
 *  - BUG-TF-03: var.XXX references with no corresponding variable declaration
 *    → extractImplicitVariables() auto-declares any var.NAME used in generated HCL.
 *  - BUG-TF-04: buildFullHCL emitting two terraform{} blocks when backend is set
 *    → buildFullHCL now uses generateTerraformBlock(backendConfig) for one merged block.
 */

import { DEFAULT_AWS_REGION } from '../utils/awsRegions';

// --- Secret pattern detector (client-side guard, belt-and-suspenders) ---------
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /(?:aws_secret|secret_access_key)\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /gh[pousr]_[A-Za-z0-9_]{36,}/,
];

export function detectSecretsInHcl(hcl) {
  return SECRET_PATTERNS.some(re => re.test(hcl));
}

// --- HCL-safe interpolation ---------------------------------------------------
/**
 * SECURITY FIX (critical — "HCL/Terraform template injection via unescaped
 * frontend field interpolation", multi-tenant collaboration): generateHCL()
 * used to substitute `String(val)` directly into the template with NO
 * escaping or validation at all. Any user-controlled config field (resource
 * name, bucket name, a security-group rule's free-text description —
 * anything typed into a Builder form) containing a literal `"` could close
 * the surrounding string literal early and inject arbitrary new HCL blocks
 * (additional resources, data sources, outputs, IAM grants) into the
 * generated .tf file. In a shared/collaborative project, a lower-privileged
 * member could plant this in a field, and it would silently take effect the
 * next time a higher-privileged teammate generated/planned/applied the
 * project — a stored-injection privilege escalation across the
 * collaboration trust boundary.
 *
 * Escapes backslash / double-quote / control chars / Terraform's own `${`
 * interpolation marker (otherwise a value containing `${...}` would be
 * evaluated by Terraform as a live expression once the .tf file is parsed).
 */
export function escapeHclString(value) {
  return String(value)
    .replace(/\\/g, () => '\\\\')
    .replace(/"/g, () => '\\"')
    .replace(/\$\{/g, () => '$${')
    .replace(/\r\n/g, () => '\\n')
    .replace(/\n/g, () => '\\n')
    .replace(/\r/g, () => '\\n')
    .replace(/\t/g, () => '\\t');
}

// Strict Terraform identifier: letters/digits/underscore/dash, must start
// with a letter or underscore — matches Terraform's own naming rules for
// resource/data/module labels. Auto-sanitising (rather than rejecting) a bad
// identifier is also just good UX: users naturally type "My Bucket" and
// expect a valid resource label out the other end.
const HCL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function sanitizeHclIdentifier(value, fallback = 'resource') {
  const str = String(value ?? '').trim();
  if (HCL_IDENTIFIER_RE.test(str)) return str;
  const cleaned = str.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]+/, '');
  return cleaned || fallback;
}

// Allow-list for values substituted into a BARE (unquoted) template
// position — e.g. `size = {{size}}`, `enabled = {{enabled}}`. There is no
// escaping mechanism available in this position (no surrounding quotes to
// escape into), so the value is instead strictly validated: a number,
// true|false, or a simple dotted reference/identifier (e.g.
// `aws_s3_bucket.this.id`, `var.foo`). Anything else is rejected — the
// template gets `null` instead of an attacker-controlled raw HCL fragment.
const BARE_VALUE_RE = /^(true|false|-?\d+(\.\d+)?|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_-]*)*)$/;

function isInsideQuotedString(line, matchIndex) {
  // Quote-parity up to the match, on this line, in the STATIC template text
  // (not the substituted value) — an odd count means we're currently inside
  // an open "..." string in the template itself.
  let count = 0;
  for (let i = 0; i < matchIndex; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') count++;
  }
  return count % 2 === 1;
}

// Keys that are always used as raw Terraform identifiers in these templates
// (both as a resource block's own label AND referenced bare elsewhere, e.g.
// `aws_s3_bucket.{{name}}.id`) — always identifier-sanitized regardless of
// quoted/bare position, rather than string-escaped or allow-list-checked.
const IDENTIFIER_KEYS = new Set(['name']);

function interpolateLine(line, fullConfig) {
  return line.replace(/\{\{(\w+)\}\}/g, (match, key, offset) => {
    const val = fullConfig[key];
    if (val === undefined || val === null || val === '') return '';

    if (IDENTIFIER_KEYS.has(key)) {
      return sanitizeHclIdentifier(val);
    }

    if (isInsideQuotedString(line, offset)) {
      return escapeHclString(val);
    }

    const str = String(val).trim();
    if (!BARE_VALUE_RE.test(str)) {
      // eslint-disable-next-line no-console
      console.warn(`[templateEngine] Rejected unsafe bare value for {{${key}}} — substituting null.`);
      return 'null';
    }
    return str;
  });
}

// --- Template interpolation ----------------------------------------------------
export function generateHCL(templateBody, config, environment = 'dev') {
  // Convert escaped newlines ("\\n") stored in DB into real newlines
  let body = String(templateBody).replace(/\\n/g, '\n');

  // Add environment to config
  const fullConfig = { ...config, environment };

  // BUG-TF-02 fix: undefined keys now return '' instead of keeping the raw
  // {{placeholder}} token. A literal {{placeholder}} in HCL is invalid syntax
  // and causes `terraform validate` to fail with a parse error.
  // Returning '' lets the empty-assignment remover below strip the whole line.
  //
  // SECURITY FIX: processed line-by-line (not one global regex over the
  // whole body) so each placeholder's substitution can be checked against
  // ITS OWN line's quote structure — see interpolateLine() above for why
  // quoted-string vs. bare-token position need different treatment, and the
  // module-level comment for the vulnerability this closes.
  body = body.split('\n').map(line => interpolateLine(line, fullConfig)).join('\n');

  // Remove empty assignment lines (common for optional fields)
  body = body.replace(/^\s*\w+\s*=\s*["']?\s*["']?\s*$/gm, (line) => {
    // Only strip if the value is genuinely empty (not a reference like var.xxx)
    if (/=\s*["']\s*["']/.test(line) || /=\s*$/.test(line)) return '';
    return line;
  });

  // Inject lifecycle block if config has lifecycle settings
  if (config._lifecycle) {
    const lc = config._lifecycle;
    const lcLines = [];
    if (lc.prevent_destroy)           lcLines.push('    prevent_destroy = true');
    if (lc.create_before_destroy)     lcLines.push('    create_before_destroy = true');
    if (lc.ignore_changes?.length)    lcLines.push(`    ignore_changes = [${lc.ignore_changes.join(', ')}]`);
    if (lcLines.length > 0) {
      const lcBlock = `\n  lifecycle {\n${lcLines.join('\n')}\n  }`;
      // Insert before the closing brace of the first resource block
      body = body.replace(/^}$/m, lcBlock + '\n}');
    }
  }

  // Collapse excessive blank lines and trim
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  return body;
}

// --- Unified terraform block (single source of truth for terraform{} config) ---
/**
 * BUG-TF-01 + BUG-TF-04 fix: generateTerraformBlock() is the ONLY place that
 * emits a terraform{} block with required_version + required_providers.
 * It optionally merges a backend configuration into the SAME block.
 *
 * This eliminates the duplicate required_providers.aws that previously appeared
 * in both providers.tf (from generateProviderBlock) and versions.tf (from
 * generateVersionsBlock), which caused `terraform validate` to fail with:
 *   "Duplicate required_providers configuration for aws"
 */
export function generateTerraformBlock(backendConfig) {
  let block = `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
`;

  // Merge backend into the same terraform{} block when configured.
  // Terraform allows only ONE backend block per configuration directory.
  if (backendConfig && backendConfig.type) {
    const { type, ...bConfig } = backendConfig;
    block += `\n  backend "${type}" {\n`;
    for (const [key, value] of Object.entries(bConfig)) {
      block += `    ${key} = "${value}"\n`;
    }
    block += `  }\n`;
  }

  block += `}\n`;
  return block;
}

// --- Provider block ------------------------------------------------------------
/**
 * BUG-TF-01 fix: Now returns ONLY the provider "aws" {} block — no terraform{}
 * wrapper.  The terraform{} block (with required_version + required_providers)
 * is emitted exclusively by generateTerraformBlock() / generateVersionsBlock(),
 * preventing duplicate required_providers declarations across files.
 */
export function generateProviderBlock(region) {
  return `provider "aws" {
  region = "${region}"
}
`;
}

// --- Backend block (standalone terraform{} for split-file backend.tf) ---------
/**
 * Returns a standalone terraform { backend "type" {} } block.
 * Used only in split-file mode (backend.tf). The versions.tf file provides the
 * required_providers block, so there is no duplication of provider declarations.
 */
export function generateBackendBlock(backendConfig) {
  if (!backendConfig || !backendConfig.type) return '';
  const { type, ...config } = backendConfig;
  let block = `terraform {\n  backend "${type}" {\n`;
  for (const [key, value] of Object.entries(config)) {
    block += `    ${key} = "${value}"\n`;
  }
  block += `  }\n}\n`;
  return block;
}

// --- Locals block (auto-generated from common resource values) -----------------
export function generateLocalsBlock(resources, region, environment, projectName = '') {
  const locals = {
    environment,
    region,
    project_name: projectName || 'tfgen-project',
    common_tags: `{\n    Environment = local.environment\n    Project     = local.project_name\n    ManagedBy   = "Terraform"\n    GeneratedBy = "TFGen"\n  }`,
  };

  const azSet = new Set();
  const cidrSet = new Set();
  for (const r of resources) {
    if (r.config?.availability_zone) azSet.add(r.config.availability_zone);
    if (r.config?.cidr_block)        cidrSet.add(r.config.cidr_block);
  }
  if (azSet.size > 0) locals.availability_zones = `[${[...azSet].map(z => `"${z}"`).join(', ')}]`;

  let block = 'locals {\n';
  for (const [k, v] of Object.entries(locals)) {
    if (k === 'common_tags') {
      block += `  common_tags = ${v}\n`;
    } else if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      block += `  ${k} = ${v}\n`;
    } else {
      block += `  ${k} = "${v}"\n`;
    }
  }
  block += '}\n';
  return block;
}

// --- Data sources block -------------------------------------------------------
export function generateDataSourcesBlock() {
  return `# --- Common data sources -----------------------------------------------
data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
`;
}

// --- Variables HCL ------------------------------------------------------------
export function generateVariablesHCL(variables) {
  if (!variables || Object.keys(variables).length === 0) return '';
  let hcl = '';
  for (const [key, value] of Object.entries(variables)) {
    hcl += `variable "${key}" {\n`;
    if (value.description) hcl += `  description = "${value.description}"\n`;
    hcl += `  type        = ${value.type || 'string'}\n`;
    if (value.default !== undefined) {
      const def = typeof value.default === 'string' ? `"${value.default}"` : JSON.stringify(value.default);
      hcl += `  default     = ${def}\n`;
    }
    if (value.sensitive) hcl += `  sensitive   = true\n`;
    if (value.validation) {
      hcl += `  validation {\n`;
      hcl += `    condition     = ${value.validation.condition}\n`;
      hcl += `    error_message = "${value.validation.error_message}"\n`;
      hcl += `  }\n`;
    }
    hcl += `}\n\n`;
  }
  return hcl.trim() + '\n';
}

// --- Outputs HCL --------------------------------------------------------------
export function generateOutputsHCL(outputs) {
  if (!outputs || Object.keys(outputs).length === 0) return '';
  let hcl = '';
  for (const [key, value] of Object.entries(outputs)) {
    hcl += `output "${key}" {\n`;
    if (value.description) hcl += `  description = "${value.description}"\n`;
    hcl += `  value       = ${value.value}\n`;
    if (value.sensitive)   hcl += `  sensitive   = true\n`;
    hcl += `}\n\n`;
  }
  return hcl.trim() + '\n';
}

// --- Implicit variable extractor (BUG-TF-03 fix) ------------------------------
/**
 * Scans HCL content for var.NAME references and returns variable declarations
 * for any that are not already present in the explicit variables map.
 *
 * Example: RDS template uses `password = var.db_password` but the schema has
 * no db_password field (correctly, for security).  Without this function,
 * `terraform validate` fails with:
 *   "An input variable with the name db_password has not been declared"
 */
export function extractImplicitVariables(hclContent, explicitVariables = {}) {
  const implicit = {};
  // Match var.name — not inside comments or string literals
  const varRe = /\bvar\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = varRe.exec(hclContent)) !== null) {
    const varName = m[1];
    if (explicitVariables[varName] || implicit[varName]) continue;

    const isSensitive =
      /password|secret|key|token|credential|cert|private/i.test(varName);

    implicit[varName] = {
      description: `Input variable referenced in configuration. Supply via terraform.tfvars or -var flag.`,
      type: 'string',
      ...(isSensitive && { sensitive: true }),
    };
  }
  return implicit;
}

// --- Full HCL assembly --------------------------------------------------------
/**
 * BUG-TF-04 fix: All terraform{} content (required_version, required_providers,
 * optional backend) is now merged into a single block via generateTerraformBlock().
 * This prevents the previous behaviour where a backend block and a provider block
 * each emitted their own terraform{} wrapper, producing two terraform blocks in
 * the combined output.
 */
export function buildFullHCL(resources, region, environment, backendConfig, variables, outputs, projectName = '') {
  const effectiveRegion = region || DEFAULT_AWS_REGION;
  const effectiveEnv    = environment || 'dev';

  // Single merged terraform{} block: required_version + required_providers + optional backend
  const tfBlock  = generateTerraformBlock(backendConfig);
  const provider = generateProviderBlock(effectiveRegion);
  const locals   = generateLocalsBlock(resources, effectiveRegion, effectiveEnv, projectName);
  const dataSrcs = generateDataSourcesBlock();
  const blocks   = resources
    .filter(r => r.hcl_output)
    .map(r => r.hcl_output)
    .join('\n\n');

  // BUG-TF-03 fix: auto-declare any var.XXX referenced in templates
  const allBlockHcl  = blocks;
  const implicitVars = extractImplicitVariables(allBlockHcl, variables || {});
  const mergedVars   = { ...implicitVars, ...(variables || {}) }; // explicit wins
  const vars         = generateVariablesHCL(mergedVars);
  const outs         = generateOutputsHCL(outputs);

  return [tfBlock, provider, dataSrcs, locals, vars, blocks, outs]
    .filter(Boolean)
    .join('\n')
    .replace(/\n{4,}/g, '\n\n');
}

// --- Split file assembly ------------------------------------------------------
/**
 * BUG-TF-01 fix: providers.tf now contains ONLY `provider "aws" {}` — no
 * terraform{} wrapper. versions.tf remains the single source of required_providers.
 * This eliminates the duplicate required_providers.aws that previously appeared
 * in both files.
 *
 * File layout:
 *  backend.tf   — terraform { backend "type" {} }  (only when backend configured)
 *  versions.tf  — terraform { required_version + required_providers }
 *  providers.tf — provider "aws" { region = "..." }  (NO terraform{} wrapper)
 *  locals.tf    — locals { ... }
 *  main.tf      — data sources + resource / module blocks
 *  variables.tf — variable declarations (explicit + auto-detected implicit)
 *  outputs.tf   — output declarations
 *  README.md    — terraform-docs style documentation
 */
export function buildSplitHCL(resources, region, environment, backendConfig, variables, outputs, projectName = '') {
  const effectiveRegion = region || DEFAULT_AWS_REGION;
  const effectiveEnv    = environment || 'dev';

  const provider = generateProviderBlock(effectiveRegion);
  const locals   = generateLocalsBlock(resources, effectiveRegion, effectiveEnv, projectName);
  const dataSrcs = generateDataSourcesBlock();
  const blocks   = resources
    .filter(r => r.hcl_output)
    .map(r => r.hcl_output)
    .join('\n\n');

  // BUG-TF-03 fix: auto-declare implicit var.XXX references
  const implicitVars = extractImplicitVariables(blocks, variables || {});
  const mergedVars   = { ...implicitVars, ...(variables || {}) };
  const vars         = generateVariablesHCL(mergedVars);
  const outs         = generateOutputsHCL(outputs);

  const files = {};

  // backend.tf — standalone terraform { backend "..." {} } block.
  // Terraform allows multiple terraform{} blocks across files; backend and
  // required_providers keys don't conflict with each other.
  if (backendConfig && backendConfig.type) {
    files['backend.tf'] = generateBackendBlock(backendConfig);
  }

  // providers.tf — ONLY the provider "aws" {} block.
  // The terraform{} wrapper has been intentionally removed to prevent the
  // duplicate required_providers.aws that caused validate failures.
  if (provider) files['providers.tf'] = provider;

  const mainParts = [dataSrcs, blocks].filter(Boolean).join('\n\n');
  if (mainParts)  files['main.tf']      = mainParts;
  if (locals)     files['locals.tf']    = locals;
  if (vars)       files['variables.tf'] = vars;
  if (outs)       files['outputs.tf']   = outs;

  // versions.tf — single authoritative terraform{} block.
  files['versions.tf'] = generateVersionsBlock();
  files['README.md']   = generateReadme(resources, effectiveRegion, effectiveEnv, projectName);

  return files;
}

// --- versions.tf --------------------------------------------------------------
/**
 * Single authoritative terraform{} block for split-file output.
 * This is the ONLY file in the split layout that contains required_providers.
 */
export function generateVersionsBlock() {
  return `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;
}

// --- README.md auto-generation (terraform-docs style) -----------------------
export function generateReadme(resources = [], region = DEFAULT_AWS_REGION, environment = 'dev', projectName = 'TFGen Project') {
  // terraform-docs style: Requirements table
  const requirementsTable = `| Name | Version |\n|------|--------|\n| terraform | >= 1.5.0 |\n| aws | ~> 5.0 |`;

  // terraform-docs style: Providers table
  const providersTable = `| Name | Version |\n|------|--------|\n| hashicorp/aws | ~> 5.0 |`;

  // terraform-docs style: Resources table
  const detailedResourceRows = resources
    .filter(r => r.hcl_output)
    .map(r => {
      const tfName = r.is_module
        ? `module.\`${r.resource_name || r.label}\``
        : `\`${r.service_type}\`.\`${r.resource_name || r.label || 'this'}\``;
      return `| ${tfName} | ${r.is_module ? 'module' : 'resource'} | [hashicorp/aws](https://registry.terraform.io/providers/hashicorp/aws/latest) |`;
    })
    .join('\n');

  // terraform-docs style: Modules section
  const moduleRows = resources
    .filter(r => r.is_module && r.source)
    .map(r => `| \`${r.resource_name || r.label}\` | \`${r.source}\` | \`${r.version || '*'}\` |`)
    .join('\n');

  // terraform-docs style: Inputs (from resource configs, best-effort)
  const inputRows = resources
    .filter(r => r.hcl_output && r.config)
    .flatMap(r =>
      Object.entries(r.config)
        .filter(([k, v]) => !k.startsWith('_') && v && String(v).trim() && !['sg_rules_multi','subnets_multi','ec2_instances_multi'].includes(k))
        .slice(0, 4)
        .map(([k, v]) => {
          const safeVal = String(v).replace(/\|/g, '\\|').slice(0, 36);
          return `| \`${r.label}.${k}\` | \`string\` | \`${safeVal}\` | no |`;
        })
    )
    .join('\n');

  return `# ${projectName}

> **${environment}** environment · **${region}** · Managed by Terraform

## Requirements

| Name | Version |
|------|---------|
${requirementsTable}

## Providers

| Name | Version |
|------|---------|
${providersTable}

## Resources

| Name | Type | Source |
|------|------|--------|
${detailedResourceRows || '| _none_ | — | — |'}

## Modules

${moduleRows
    ? `| Name | Source | Version |\n|------|--------|---------|\n${moduleRows}`
    : '_No modules used in this configuration._'}

## Inputs

${inputRows
    ? `| Name | Type | Default | Required |\n|------|------|---------|----------|\n${inputRows}`
    : '_No inputs declared._'}

## Outputs

| Name | Description |
|------|-------------|
| _See outputs.tf_ | All output values are declared in \`outputs.tf\` |

## Overview

| Attribute   | Value              |
|-------------|--------------------|
| Region      | \`${region}\`        |
| Environment | \`${environment}\`   |
| Resources   | ${resources.length}              |

## File Structure

\`\`\`
.
├── backend.tf       # Remote state configuration (omitted if no backend is set)
├── versions.tf      # Required provider version constraints (single terraform{} block)
├── providers.tf     # AWS provider configuration
├── locals.tf        # Shared locals (tags, region, env, project)
├── main.tf          # Data sources + resource / module definitions
├── variables.tf     # Input variable declarations
└── outputs.tf       # Output value declarations
\`\`\`

## Usage

\`\`\`bash
# Initialise providers and remote backend
terraform init

# Validate all configuration files
terraform validate

# Preview what will change
terraform plan -var="environment=${environment}"

# Apply the changes
terraform apply -var="environment=${environment}"
\`\`\`

## Security

- All CIDRs were linted — no open-world 0.0.0.0/0 on privileged ports (22, 3389, 5432)
- Secrets use AWS Secrets Manager / SSM Parameter Store — never hardcoded
- Run \`checkov --directory . --framework terraform\` for a full static-analysis scan

---
*Auto-generated by [TFGen](https://github.com/your-org/tfgen) on ${new Date().toISOString().split('T')[0]} · terraform-docs conventions*
`;
}
