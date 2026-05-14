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

  // Remove subnet_id lines that are now empty (common pattern in templates)
  body = body.replace(/^\s*subnet_id\s*=\s*["']?\s*["']?\s*$/gm, '');

  // Remove any consecutive blank lines created by the cleanup and trim
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  return body;
}

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

export function generateBackendBlock(backendConfig) {
  if (!backendConfig || !backendConfig.type) return '';
  const { type, ...config } = backendConfig;
  let block = `terraform {
  backend "${type}" {
`;
  for (const [key, value] of Object.entries(config)) {
    block += `    ${key} = "${value}"\n`;
  }
  block += `  }
}
`;
  return block;
}

export function generateVariablesHCL(variables) {
  if (!variables || Object.keys(variables).length === 0) return '';
  let hcl = '';
  for (const [key, value] of Object.entries(variables)) {
    hcl += `variable "${key}" {
  description = "${value.description || ''}"
  type        = ${value.type || 'string'}
  default     = ${JSON.stringify(value.default)}
}
`;
  }
  return hcl;
}

export function generateOutputsHCL(outputs) {
  if (!outputs || Object.keys(outputs).length === 0) return '';
  let hcl = '';
  for (const [key, value] of Object.entries(outputs)) {
    hcl += `output "${key}" {
  description = "${value.description || ''}"
  value       = ${value.value}
}
`;
  }
  return hcl;
}

export function buildFullHCL(resources, region, environment, backendConfig, variables, outputs) {
  const provider = generateProviderBlock(region || 'ap-south-1');
  const backend = generateBackendBlock(backendConfig);
  const vars = generateVariablesHCL(variables);
  const outs = generateOutputsHCL(outputs);
  const blocks = resources
    .filter(r => r.hcl_output)
    .map(r => r.hcl_output)
    .join('\n\n');
  return [backend, provider, vars, blocks, outs].filter(Boolean).join('\n');
}
