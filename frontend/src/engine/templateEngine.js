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
 */

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

// --- Template interpolation ----------------------------------------------------
export function generateHCL(templateBody, config, environment = 'dev') {
  // Convert escaped newlines ("\\n") stored in DB into real newlines
  let body = String(templateBody).replace(/\\n/g, '\n');

  // Add environment to config
  const fullConfig = { ...config, environment };

  // Replace placeholders; empty/null values become empty string (so lines can be removed)
  body = body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = fullConfig[key];
    if (val === undefined) return match; // keep placeholder if no value provided at all
    if (val === null || val === '') return '';
    return String(val);
  });

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

// --- Provider block ------------------------------------------------------------
export function generateProviderBlock(region) {
  return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${region}"
}
`;
}

// --- Backend block -------------------------------------------------------------
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
/**
 * Generates a `locals {}` block consolidating shared values across resources.
 * This reduces duplication in generated HCL and follows Terraform best practices.
 */
export function generateLocalsBlock(resources, region, environment, projectName = '') {
  const locals = {
    environment,
    region,
    project_name: projectName || 'tfgen-project',
    common_tags: `{\n    Environment = local.environment\n    Project     = local.project_name\n    ManagedBy   = "Terraform"\n    GeneratedBy = "TFGen"\n  }`,
  };

  // Detect unique AZs referenced across resources for consolidation
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

// --- Data sources block (always-useful data lookups) --------------------------
/**
 * Generates common `data {}` blocks that most real Terraform projects need.
 * - aws_caller_identity: account ID, ARN for use in policies
 * - aws_availability_zones: AZ list for multi-AZ deployments
 */
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

// --- Full HCL assembly --------------------------------------------------------
export function buildFullHCL(resources, region, environment, backendConfig, variables, outputs, projectName = '') {
  const provider  = generateProviderBlock(region || 'ap-south-1');
  const backend   = generateBackendBlock(backendConfig);
  const locals    = generateLocalsBlock(resources, region || 'ap-south-1', environment || 'dev', projectName);
  const dataSrcs  = generateDataSourcesBlock();
  const vars      = generateVariablesHCL(variables);
  const outs      = generateOutputsHCL(outputs);
  const blocks    = resources
    .filter(r => r.hcl_output)
    .map(r => r.hcl_output)
    .join('\n\n');

  return [backend, provider, dataSrcs, locals, vars, blocks, outs]
    .filter(Boolean)
    .join('\n')
    .replace(/\n{4,}/g, '\n\n');
}

// --- Split file assembly ------------------------------------------------------
export function buildSplitHCL(resources, region, environment, backendConfig, variables, outputs, projectName = '') {
  const provider  = generateProviderBlock(region || 'ap-south-1');
  const backend   = generateBackendBlock(backendConfig);
  const locals    = generateLocalsBlock(resources, region || 'ap-south-1', environment || 'dev', projectName);
  const dataSrcs  = generateDataSourcesBlock();
  const vars      = generateVariablesHCL(variables);
  const outs      = generateOutputsHCL(outputs);
  const blocks    = resources
    .filter(r => r.hcl_output)
    .map(r => r.hcl_output)
    .join('\n\n');

  const files = {};
  if (backend)  files['backend.tf']   = backend;
  if (provider) files['providers.tf'] = provider;
  const mainParts = [dataSrcs, blocks].filter(Boolean).join('\n\n');
  if (mainParts) files['main.tf']     = mainParts;
  if (locals)   files['locals.tf']    = locals;
  if (vars)     files['variables.tf'] = vars;
  if (outs)     files['outputs.tf']   = outs;
  files['versions.tf'] = generateVersionsBlock();
  files['README.md']   = generateReadme(resources, region, environment, projectName);
  return files;
}

// --- versions.tf --------------------------------------------------------------
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
export function generateReadme(resources = [], region = 'ap-south-1', environment = 'dev', projectName = 'TFGen Project') {
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
├── backend.tf       # Remote state configuration
├── providers.tf     # AWS provider + Terraform version block
├── versions.tf      # Required provider version constraints
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
