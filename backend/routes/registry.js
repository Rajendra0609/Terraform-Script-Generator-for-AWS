'use strict';
/**
 * /api/registry — Terraform Module Registry Browser
 * Proxies registry.terraform.io with curated fallback when offline.
 *
 * GET  /api/registry/search                               Search modules
 * GET  /api/registry/module/:ns/:name/:provider           Module details + inputs
 * GET  /api/registry/module/:ns/:name/:provider/versions  Version list
 * POST /api/registry/import                               Generate HCL module block
 */
const router  = require('express').Router();
const https   = require('https');
const { optionalAuth } = require('../middleware/auth');
const { DEFAULT_AWS_REGION } = require('../config/region');

const REGISTRY_BASE = 'https://registry.terraform.io/v1';
const TIMEOUT_MS    = 8000;

// SECURITY FIX (L-10): namespace/name/provider come straight from
// req.params with no validation. The registry host itself is fixed
// (registry.terraform.io), so this was never cross-host SSRF, but an
// unescaped/malformed segment could still produce a malformed or
// unexpected upstream request. Terraform's own registry naming rules only
// allow alphanumeric characters, hyphens, and underscores for these
// segments — validated here (400 on anything else) AND encodeURIComponent
// is applied before interpolating into the URL, as defense-in-depth on top
// of the allow-list rather than instead of it.
const REGISTRY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function isValidRegistrySegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && REGISTRY_SEGMENT_RE.test(s);
}

// ─── Curated fallback when live registry is unreachable ─────────────────────
const CURATED = [
  { namespace:'terraform-aws-modules', name:'vpc',          provider:'aws', latest:'5.8.1',  verified:true,  downloads:78000000, description:'Terraform module to create AWS VPC resources with public, private, and database subnets across multiple AZs.' },
  { namespace:'terraform-aws-modules', name:'ec2-instance', provider:'aws', latest:'5.6.1',  verified:true,  downloads:32000000, description:'Terraform module to provision EC2 instances on AWS with optional EIP, security group, and IAM instance profile.' },
  { namespace:'terraform-aws-modules', name:'alb',          provider:'aws', latest:'9.7.0',  verified:true,  downloads:45000000, description:'Terraform module to create Application and Network Load Balancers, target groups and listeners on AWS.' },
  { namespace:'terraform-aws-modules', name:'rds',          provider:'aws', latest:'6.7.0',  verified:true,  downloads:28000000, description:'Terraform module which creates RDS resources including DB instance, DB subnet group, and DB parameter group.' },
  { namespace:'terraform-aws-modules', name:'eks',          provider:'aws', latest:'20.8.5', verified:true,  downloads:22000000, description:'Terraform module to create an Amazon EKS cluster and associated worker groups and node groups.' },
  { namespace:'terraform-aws-modules', name:'s3-bucket',    provider:'aws', latest:'4.1.2',  verified:true,  downloads:55000000, description:'Terraform module which creates S3 bucket resources with versioning, encryption, lifecycle rules and bucket policies.' },
  { namespace:'terraform-aws-modules', name:'lambda',       provider:'aws', latest:'7.7.0',  verified:true,  downloads:19000000, description:'Terraform module to build and deploy AWS Lambda functions with IAM roles, event source mappings and triggers.' },
  { namespace:'terraform-aws-modules', name:'iam',          provider:'aws', latest:'5.39.1', verified:true,  downloads:40000000, description:'Terraform module to create IAM resources including users, groups, roles, policies and their attachments.' },
  { namespace:'terraform-aws-modules', name:'security-group', provider:'aws', latest:'5.1.2', verified:true, downloads:36000000, description:'Terraform module to create EC2-VPC security groups with a large list of pre-defined named rules.' },
  { namespace:'terraform-aws-modules', name:'cloudfront',   provider:'aws', latest:'3.4.0',  verified:true,  downloads:14000000, description:'Terraform module that creates AWS CloudFront distribution and associated resources.' },
  { namespace:'terraform-aws-modules', name:'autoscaling',  provider:'aws', latest:'7.7.0',  verified:true,  downloads:17000000, description:'Terraform module to create Auto Scaling resources including ASG, launch template, scaling policies and lifecycle hooks.' },
  { namespace:'terraform-aws-modules', name:'elasticache',  provider:'aws', latest:'1.2.2',  verified:false, downloads:8000000,  description:'Terraform module to create ElastiCache resources including cluster and replication groups for Redis and Memcached.' },
  { namespace:'terraform-aws-modules', name:'rds-aurora',   provider:'aws', latest:'9.3.1',  verified:true,  downloads:11000000, description:'Terraform module which creates RDS Aurora resources including Aurora cluster, cluster instances, and Enhanced Monitoring.' },
  { namespace:'terraform-aws-modules', name:'route53',      provider:'aws', latest:'2.11.1', verified:true,  downloads:12000000, description:'Terraform module to create Route53 hosted zones, records, health checks and query logging.' },
  { namespace:'terraform-aws-modules', name:'ecs',          provider:'aws', latest:'5.11.2', verified:true,  downloads:9000000,  description:'Terraform module to create AWS Elastic Container Service (ECS) resources including cluster, services and task definitions.' },
  { namespace:'hashicorp',             name:'consul',        provider:'aws', latest:'0.10.0', verified:true,  downloads:5000000,  description:'A Terraform module to deploy a Consul cluster in AWS using Auto Scaling Groups.' },
  { namespace:'cloudposse',            name:'vpc',           provider:'aws', latest:'2.2.0',  verified:false, downloads:4000000,  description:'Terraform module to provision a VPC with Internet Gateway, multi-tier subnets and NAT Gateways.' },
  { namespace:'cloudposse',            name:'eks-cluster',   provider:'aws', latest:'4.2.0',  verified:false, downloads:3500000,  description:'Terraform module to provision an EKS cluster with managed node groups and Fargate profiles.' },
  // v9 additions
  { namespace:'terraform-aws-modules', name:'rds-aurora',    provider:'aws', latest:'9.3.1',  verified:true,  downloads:11000000, description:'Terraform module which creates RDS Aurora cluster, cluster instances, subnet group and parameter group.' },
  { namespace:'terraform-aws-modules', name:'kms',           provider:'aws', latest:'3.1.0',  verified:true,  downloads:14000000, description:'Terraform module that creates AWS KMS keys, aliases and grants.' },
  { namespace:'terraform-aws-modules', name:'acm',           provider:'aws', latest:'4.5.0',  verified:true,  downloads:18000000, description:'Terraform module which creates and validates ACM certificates with DNS or email validation.' },
  { namespace:'terraform-aws-modules', name:'notify-slack',  provider:'aws', latest:'6.4.0',  verified:true,  downloads:7000000,  description:'Terraform module that creates SNS topic and Lambda to send AWS notifications to Slack.' },
  { namespace:'terraform-aws-modules', name:'eventbridge',   provider:'aws', latest:'3.2.0',  verified:true,  downloads:5000000,  description:'Terraform module for EventBridge buses, rules, targets, pipes and API destinations.' },
  { namespace:'terraform-aws-modules', name:'step-functions',provider:'aws', latest:'2.8.0',  verified:true,  downloads:4000000,  description:'Terraform module to create Step Functions state machines with IAM roles and CloudWatch logging.' },
  { namespace:'terraform-aws-modules', name:'batch',         provider:'aws', latest:'2.0.1',  verified:true,  downloads:2500000,  description:'Terraform module to create AWS Batch compute environments, job queues and job definitions.' },
  { namespace:'terraform-aws-modules', name:'memory-db',     provider:'aws', latest:'1.2.1',  verified:true,  downloads:1800000,  description:'Terraform module for MemoryDB for Redis including cluster, subnet group and parameter group.' },
  { namespace:'terraform-aws-modules', name:'opensearch',    provider:'aws', latest:'1.3.0',  verified:true,  downloads:3200000,  description:'Terraform module to create Amazon OpenSearch domains with encryption and VPC support.' },
  { namespace:'terraform-aws-modules', name:'redshift',      provider:'aws', latest:'5.0.0',  verified:true,  downloads:4100000,  description:'Terraform module for Redshift cluster, subnet group, parameter group and IAM roles.' },
  { namespace:'terraform-aws-modules', name:'transit-gateway',provider:'aws',latest:'2.12.0', verified:true,  downloads:5500000,  description:'Terraform module for AWS Transit Gateway, attachments, route tables and routes.' },
  { namespace:'terraform-aws-modules', name:'msk',           provider:'aws', latest:'2.8.0',  verified:true,  downloads:3600000,  description:'Terraform module for MSK (Managed Streaming for Kafka) clusters and configuration.' },
  { namespace:'terraform-aws-modules', name:'sagemaker',     provider:'aws', latest:'1.1.0',  verified:false, downloads:1200000,  description:'Terraform module for SageMaker domains, user profiles and notebook instances.' },
  { namespace:'cloudposse',            name:'cognito-user-pool', provider:'aws', latest:'0.22.1', verified:false, downloads:890000, description:'Cloud Posse module to create and manage AWS Cognito User Pools with custom attributes.' },
];

// ─── Input templates per module ──────────────────────────────────────────────
const MODULE_INPUTS = {
  'terraform-aws-modules/vpc/aws': [
    { key:'name',                    type:'string',  required:true,  default:'',          description:'Name prefix for all resources' },
    { key:'cidr',                    type:'string',  required:true,  default:'10.0.0.0/16', description:'VPC CIDR block' },
    { key:'azs',                     type:'list',    required:true,  default:JSON.stringify([`${DEFAULT_AWS_REGION}a`,`${DEFAULT_AWS_REGION}b`,`${DEFAULT_AWS_REGION}c`]), description:'Availability zones' },
    { key:'private_subnets',         type:'list',    required:false, default:'["10.0.1.0/24","10.0.2.0/24","10.0.3.0/24"]', description:'Private subnet CIDRs' },
    { key:'public_subnets',          type:'list',    required:false, default:'["10.0.101.0/24","10.0.102.0/24","10.0.103.0/24"]', description:'Public subnet CIDRs' },
    { key:'enable_nat_gateway',      type:'bool',    required:false, default:'true',      description:'Enable NAT Gateway for private subnets' },
    { key:'single_nat_gateway',      type:'bool',    required:false, default:'false',     description:'Use a single NAT Gateway (saves cost in dev)' },
    { key:'enable_dns_hostnames',    type:'bool',    required:false, default:'true',      description:'Enable DNS hostnames in VPC' },
    { key:'enable_dns_support',      type:'bool',    required:false, default:'true',      description:'Enable DNS support in VPC' },
    { key:'tags',                    type:'map',     required:false, default:'{ Terraform = "true" }', description:'Tags to apply to all resources' },
  ],
  'terraform-aws-modules/ec2-instance/aws': [
    { key:'name',                    type:'string',  required:true,  default:'',          description:'Name of the EC2 instance' },
    { key:'instance_type',           type:'string',  required:true,  default:'t3.micro',  description:'EC2 instance type' },
    { key:'ami',                     type:'string',  required:true,  default:'',          description:'AMI ID (use data source for latest)' },
    { key:'subnet_id',               type:'string',  required:true,  default:'',          description:'Subnet ID to launch the instance in' },
    { key:'vpc_security_group_ids',  type:'list',    required:true,  default:'[]',        description:'Security group IDs to associate' },
    { key:'iam_instance_profile_name', type:'string', required:false, default:'',         description:'IAM instance profile name to attach' },
    { key:'associate_public_ip_address', type:'bool', required:false, default:'false',    description:'Associate a public IP address' },
    { key:'user_data',               type:'string',  required:false, default:'',          description:'User data bootstrap script' },
    { key:'tags',                    type:'map',     required:false, default:'{ Terraform = "true" }', description:'Tags to apply' },
  ],
  'terraform-aws-modules/alb/aws': [
    { key:'name',                    type:'string',  required:true,  default:'',          description:'Name of the ALB' },
    { key:'vpc_id',                  type:'string',  required:true,  default:'',          description:'VPC ID for the ALB' },
    { key:'subnets',                 type:'list',    required:true,  default:'[]',        description:'Subnet IDs (min 2 in different AZs)' },
    { key:'security_groups',         type:'list',    required:true,  default:'[]',        description:'Security group IDs' },
    { key:'target_groups',           type:'list',    required:false, default:'[]',        description:'Target group configurations' },
    { key:'https_listeners',         type:'list',    required:false, default:'[]',        description:'HTTPS listener configurations' },
    { key:'http_tcp_listeners',      type:'list',    required:false, default:'[]',        description:'HTTP listener configurations' },
    { key:'tags',                    type:'map',     required:false, default:'{}',        description:'Tags to apply' },
  ],
  'terraform-aws-modules/rds/aws': [
    { key:'identifier',              type:'string',  required:true,  default:'',          description:'RDS instance identifier' },
    { key:'engine',                  type:'string',  required:true,  default:'postgres',  description:'Database engine (postgres, mysql, etc.)' },
    { key:'engine_version',          type:'string',  required:true,  default:'16',        description:'Engine version' },
    { key:'instance_class',          type:'string',  required:true,  default:'db.t3.micro', description:'RDS instance class' },
    { key:'allocated_storage',       type:'number',  required:true,  default:'20',        description:'Initial storage allocation in GB' },
    { key:'db_name',                 type:'string',  required:true,  default:'',          description:'Database name' },
    { key:'username',                type:'string',  required:true,  default:'',          description:'Master username' },
    { key:'port',                    type:'number',  required:false, default:'5432',      description:'Database port' },
    { key:'multi_az',                type:'bool',    required:false, default:'false',     description:'Enable Multi-AZ' },
    { key:'deletion_protection',     type:'bool',    required:false, default:'false',     description:'Enable deletion protection' },
    { key:'vpc_security_group_ids',  type:'list',    required:true,  default:'[]',        description:'Security group IDs' },
    { key:'subnet_ids',              type:'list',    required:true,  default:'[]',        description:'Subnet IDs for DB subnet group' },
    { key:'tags',                    type:'map',     required:false, default:'{}',        description:'Tags to apply' },
  ],
  'terraform-aws-modules/eks/aws': [
    { key:'cluster_name',            type:'string',  required:true,  default:'',          description:'Name of the EKS cluster' },
    { key:'cluster_version',         type:'string',  required:false, default:'1.29',      description:'Kubernetes version' },
    { key:'vpc_id',                  type:'string',  required:true,  default:'',          description:'VPC ID' },
    { key:'subnet_ids',              type:'list',    required:true,  default:'[]',        description:'Private subnet IDs for nodes' },
    { key:'cluster_endpoint_public_access', type:'bool', required:false, default:'true',  description:'Allow public API endpoint access' },
    { key:'eks_managed_node_groups', type:'map',     required:false, default:'{}',        description:'Managed node group configurations' },
    { key:'tags',                    type:'map',     required:false, default:'{}',        description:'Tags to apply' },
  ],
  'terraform-aws-modules/s3-bucket/aws': [
    { key:'bucket',                  type:'string',  required:false, default:'',          description:'Bucket name (auto-generated if empty)' },
    { key:'versioning',              type:'map',     required:false, default:'{ enabled = true }', description:'Versioning configuration' },
    { key:'server_side_encryption_configuration', type:'map', required:false, default:'{}', description:'Encryption configuration' },
    { key:'lifecycle_rule',          type:'list',    required:false, default:'[]',        description:'Lifecycle rules' },
    { key:'block_public_acls',       type:'bool',    required:false, default:'true',      description:'Block public ACLs' },
    { key:'block_public_policy',     type:'bool',    required:false, default:'true',      description:'Block public bucket policies' },
    { key:'tags',                    type:'map',     required:false, default:'{}',        description:'Tags to apply' },
  ],
  'terraform-aws-modules/lambda/aws': [
    { key:'function_name',           type:'string',  required:true,  default:'',          description:'Lambda function name' },
    { key:'handler',                 type:'string',  required:true,  default:'index.handler', description:'Function handler' },
    { key:'runtime',                 type:'string',  required:true,  default:'nodejs20.x', description:'Runtime (nodejs20.x, python3.12, etc.)' },
    { key:'source_path',             type:'string',  required:false, default:'',          description:'Path to source code to zip' },
    { key:'memory_size',             type:'number',  required:false, default:'128',       description:'Memory allocation in MB' },
    { key:'timeout',                 type:'number',  required:false, default:'30',        description:'Function timeout in seconds' },
    { key:'environment_variables',   type:'map',     required:false, default:'{}',        description:'Environment variables' },
    { key:'attach_policy_statements', type:'bool',   required:false, default:'false',     description:'Attach custom policy statements' },
    { key:'tags',                    type:'map',     required:false, default:'{}',        description:'Tags to apply' },
  ],
};

function getDefaultInputs(ns, name, provider) {
  return MODULE_INPUTS[`${ns}/${name}/${provider}`] || [
    { key:'name',   type:'string', required:true,  default:'',     description:'Resource name' },
    { key:'region', type:'string', required:false, default:'',     description:'AWS region override' },
    { key:'tags',   type:'map',    required:false, default:'{}',   description:'Tags to apply to resources' },
  ];
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch(e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get('/search', optionalAuth, async (req, res) => {
  const { q = '', provider = 'aws', limit = '20', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit) || 20, 50);

  try {
    const url = `${REGISTRY_BASE}/modules?q=${encodeURIComponent(q)}&provider=${provider}&limit=${lim}&offset=${offset}&verified=true`;
    const data = await fetchJson(url);

    const modules = (data.modules || []).map(m => ({
      namespace:   m.namespace,
      name:        m.name,
      provider:    m.provider,
      latest:      m.version,
      description: m.description || '',
      downloads:   m.downloads || 0,
      verified:    m.verified || false,
      source:      m.source,
      published_at: m.published_at,
    }));

    res.json({ modules, offline: false, total: data.meta?.total || modules.length });
  } catch (e) {
    // Fallback to curated list
    const prov = provider.toLowerCase();
    const query = q.toLowerCase();
    const filtered = CURATED.filter(m =>
      m.provider === prov &&
      (!query || m.name.includes(query) || m.description.toLowerCase().includes(query) || m.namespace.includes(query))
    );
    res.json({ modules: filtered.slice(0, lim), offline: true, total: filtered.length, reason: e.message });
  }
});

router.get('/module/:ns/:name/:provider', optionalAuth, async (req, res) => {
  const { ns, name, provider } = req.params;
  if (![ns, name, provider].every(isValidRegistrySegment)) {
    return res.status(400).json({ error: 'Invalid module namespace, name, or provider' });
  }
  const key = `${ns}/${name}/${provider}`;
  const inputs = getDefaultInputs(ns, name, provider);

  try {
    const url = `${REGISTRY_BASE}/modules/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}`;
    const data = await fetchJson(url);
    const root = data.root || {};
    const liveInputs = (root.inputs || []).map(i => ({
      key:         i.name,
      type:        i.type || 'string',
      required:    !i.default || i.default === '',
      default:     i.default || '',
      description: i.description || '',
    }));
    res.json({
      namespace: ns, name, provider,
      description: data.description || '',
      source:      data.source || `${ns}/${name}/${provider}`,
      readme:      root.readme || '',
      input_template: liveInputs.length ? liveInputs : inputs,
      outputs: (root.outputs || []).map(o => ({ key: o.name, description: o.description || '' })),
      offline: false,
    });
  } catch (e) {
    const meta = CURATED.find(m => m.namespace===ns && m.name===name && m.provider===provider);
    res.json({
      namespace: ns, name, provider,
      description: meta?.description || '',
      source:      key,
      input_template: inputs,
      outputs: [],
      offline: true,
    });
  }
});

router.get('/module/:ns/:name/:provider/versions', optionalAuth, async (req, res) => {
  const { ns, name, provider } = req.params;
  if (![ns, name, provider].every(isValidRegistrySegment)) {
    return res.status(400).json({ error: 'Invalid module namespace, name, or provider' });
  }
  try {
    const url = `${REGISTRY_BASE}/modules/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}/versions`;
    const data = await fetchJson(url);
    res.json(data);
  } catch (e) {
    const meta = CURATED.find(m => m.namespace===ns && m.name===name && m.provider===provider);
    res.json({ modules: [{ versions: [{ version: meta?.latest || '1.0.0' }] }] });
  }
});

router.post('/import', optionalAuth, (req, res) => {
  const { module: mod, version, inputs = {}, module_name } = req.body;
  if (!mod) return res.status(400).json({ error: 'module is required' });

  const mName  = (module_name || mod.name).replace(/[^a-z0-9_]/gi, '_');
  const source = `${mod.namespace}/${mod.name}/${mod.provider}`;
  const ver    = version || mod.latest || '';

  const inputLines = Object.entries(inputs)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => {
      // Detect type
      if (v === 'true' || v === 'false') return `  ${k} = ${v}`;
      if (!isNaN(v) && v !== '') return `  ${k} = ${v}`;
      if (v.startsWith('[') || v.startsWith('{')) return `  ${k} = ${v}`;
      return `  ${k} = "${v}"`;
    });

  const hcl = [
    `# Module: ${source}`,
    `# Docs: https://registry.terraform.io/modules/${source}/latest`,
    ``,
    `module "${mName}" {`,
    `  source  = "${source}"`,
    ver ? `  version = "~> ${ver}"` : '',
    ``,
    ...inputLines,
    `}`,
    ``,
    `# Useful outputs from this module:`,
    `# module.${mName}.<output_name>`,
    `# Run: terraform output (after apply) to see all outputs`,
  ].filter(l => l !== null).join('\n');

  res.json({ hcl, source, version: ver, module_name: mName });
});

module.exports = router;
