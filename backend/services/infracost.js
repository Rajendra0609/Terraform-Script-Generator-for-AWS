'use strict';
/**
 * Infracost integration service.
 * Invokes Infracost CLI inside Docker or falls back to a curated
 * cost-per-resource lookup table when Infracost is unavailable.
 *
 * Infracost docs: https://www.infracost.io/docs/
 */
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { isDockerAvailable } = require('../utils/dockerAvailable');

const INFRACOST_IMAGE   = process.env.INFRACOST_IMAGE   || 'infracost/infracost:latest';
const INFRACOST_API_KEY = process.env.INFRACOST_API_KEY || '';
const WORKSPACE         = path.join(os.tmpdir(), 'tfgen-infracost');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Static cost table (USD / month) ────────────────────────────────────────
// Used when Infracost is unavailable. Based on us-east-1 on-demand pricing
// (rounded, for estimation only).
const STATIC_COSTS = {
  'aws_instance': {
    't2.micro': 8.47, 't2.small': 16.93, 't2.medium': 33.87,
    't3.micro': 7.59, 't3.small': 15.18, 't3.medium': 30.37, 't3.large': 60.74,
    'm5.large': 70.08, 'm5.xlarge': 140.16, 'm5.2xlarge': 280.32,
    'c5.large': 62.05, 'c5.xlarge': 124.10,
    'r5.large': 91.25, 'r5.xlarge': 182.50,
    'default': 30.00,
  },
  'aws_db_instance': {
    'db.t3.micro': 12.41, 'db.t3.small': 24.82, 'db.t3.medium': 49.64,
    'db.m5.large': 138.70, 'db.m5.xlarge': 277.40,
    'default': 80.00,
  },
  'aws_rds_cluster': { 'default': 200.00 },
  'aws_elasticache_cluster': {
    'cache.t3.micro': 13.14, 'cache.t3.small': 26.28, 'cache.m5.large': 130.00,
    'default': 50.00,
  },
  'aws_lb':                   { 'default': 16.20 },
  'aws_alb':                  { 'default': 16.20 },
  'aws_nat_gateway':          { 'default': 32.40 },
  'aws_cloudfront_distribution': { 'default': 0.00 },  // usage-based
  'aws_lambda_function':      { 'default': 0.00 },      // usage-based
  'aws_s3_bucket':            { 'default': 0.00 },      // usage-based
  'aws_ebs_volume':           { 'gp3': 0.08, 'gp2': 0.10, 'io1': 0.125, 'default': 0.08 }, // per GB per month
  'aws_efs_file_system':      { 'default': 0.30 },      // per GB/month
  'aws_eks_cluster':          { 'default': 73.00 },     // cluster fee only
  'aws_ecs_cluster':          { 'default': 0.00 },      // tasks billed separately
  'aws_dynamodb_table':       { 'default': 0.00 },      // on-demand pricing
  'aws_cloudwatch_metric_alarm': { 'default': 0.10 },
  'aws_sns_topic':            { 'default': 0.00 },      // usage-based
  'aws_sqs_queue':            { 'default': 0.00 },      // usage-based
  'aws_kms_key':              { 'default': 1.00 },
  'aws_backup_plan':          { 'default': 0.00 },      // data-based

  // ── v9 services ──────────────────────────────────────────────────────────
  // Compute
  'aws_apprunner_service':                     { 'default': 5.00 },   // usage-based, ~$5 min
  'aws_batch_compute_environment':             { 'default': 0.00 },   // EC2 cost only
  'aws_lambda_layer_version':                  { 'default': 0.00 },   // storage only
  'aws_lambda_function_url':                   { 'default': 0.00 },   // usage-based
  'aws_lambda_event_source_mapping':           { 'default': 0.00 },   // no direct cost
  'aws_imagebuilder_image_pipeline':           { 'default': 0.00 },   // EC2 cost when running
  'aws_key_pair':                              { 'default': 0.00 },   // free

  // Storage
  'aws_s3_bucket_policy':                      { 'default': 0.00 },   // free
  'aws_transfer_server':                       { 'default': 216.00 }, // ~$216/mo endpoint + data
  'aws_backup_vault':                          { 'default': 0.00 },   // storage-based
  'aws_storagegateway_gateway':                { 'default': 125.00 }, // ~$125/mo

  // Networking
  'aws_lb_target_group':                       { 'default': 0.00 },   // free (LB pays)
  'aws_lb_listener':                           { 'default': 0.00 },   // free (LB pays)
  'aws_lb_listener_rule':                      { 'default': 0.00 },   // free
  'aws_route53_record':                        { 'default': 0.50 },   // $0.50/mo/zone query
  'aws_route53_resolver_endpoint':             { 'default': 50.00 },  // ~$50/mo per ENI
  'aws_route53_resolver_rule':                 { 'default': 0.40 },   // $0.40/mo
  'aws_vpc_ipam':                              { 'default': 2.00 },   // $0.00027/hr per IP
  'aws_vpc_ipam_pool':                         { 'default': 0.00 },   // free

  // Database
  'aws_db_subnet_group':                       { 'default': 0.00 },   // free
  'aws_db_parameter_group':                    { 'default': 0.00 },   // free
  'aws_dax_cluster': {
    'dax.t3.small': 30.00, 'dax.t3.medium': 60.00,
    'dax.r4.large': 185.00, 'dax.r5.large': 175.00, 'default': 30.00,
  },
  'aws_neptune_cluster':                       { 'default': 110.00 }, // db.t3.medium ~$70 + storage
  'aws_memorydb_cluster': {
    'db.t4g.small': 48.00, 'db.t4g.medium': 95.00,
    'db.r6g.large': 185.00, 'default': 48.00,
  },
  'aws_keyspaces_table':                       { 'default': 0.00 },   // on-demand

  // IAM & Security
  'aws_accessanalyzer_analyzer':               { 'default': 0.00 },   // free (account scope)
  'aws_shield_protection':                     { 'default': 3000.00 },// $3000/mo Shield Advanced
  'aws_fms_policy':                            { 'default': 100.00 }, // per policy per account
  'aws_ssoadmin_permission_set':               { 'default': 0.00 },   // free
  'aws_ram_resource_share':                    { 'default': 0.00 },   // free
  'aws_directory_service_directory':           { 'default': 144.00 }, // Standard ~$144/mo
  'aws_cognito_identity_pool':                 { 'default': 0.00 },   // usage-based
  'aws_acmpca_certificate_authority':          { 'default': 400.00 }, // $400/mo per CA
  'aws_verifiedaccess_instance':               { 'default': 0.00 },   // usage-based

  // Monitoring
  'aws_cloudwatch_composite_alarm':            { 'default': 0.50 },   // $0.50/alarm/mo
  'aws_synthetics_canary':                     { 'default': 1.00 },   // $0.0012/canary run
  'aws_cloudwatch_metric_stream':              { 'default': 3.00 },   // $0.003/1000 metrics
  'aws_rum_app_monitor':                       { 'default': 1.00 },   // $1/100k events
  'aws_pipes_pipe':                            { 'default': 0.00 },   // usage-based
  'aws_scheduler_schedule':                    { 'default': 0.00 },   // $1/million invocations
  'aws_devopsguru_resource_collection':        { 'default': 0.00 },   // usage-based
  'aws_chatbot_slack_channel_configuration':   { 'default': 0.00 },   // free

  // Containers
  'aws_eks_addon':                             { 'default': 0.00 },   // free
  'aws_appmesh_mesh':                          { 'default': 0.00 },   // usage-based
  'aws_ecr_lifecycle_policy':                  { 'default': 0.00 },   // free
  'aws_ecs_capacity_provider':                 { 'default': 0.00 },   // free (EC2 costs separately)
  'aws_eks_identity_provider_config':          { 'default': 0.00 },   // free
  'aws_ecrpublic_repository':                  { 'default': 0.00 },   // free under 50GB

  // CI/CD
  'aws_codestarconnections_connection':        { 'default': 0.00 },   // free
  'aws_api_gateway_domain_name':               { 'default': 0.00 },   // free (API GW pays)
  'aws_api_gateway_stage':                     { 'default': 0.00 },   // free
  'aws_appconfig_application':                 { 'default': 0.00 },   // free
  'aws_cloud9_environment_ec2':                { 'default': 7.59 },   // t3.micro EC2 cost
  'aws_codegurureviewer_repository_association':{ 'default': 10.00 }, // per 100 lines reviewed
  'aws_servicecatalog_portfolio':              { 'default': 0.00 },   // free

  // Admin & Ops
  'aws_cloudformation_stack':                  { 'default': 0.00 },   // free
  'aws_resourcegroups_group':                  { 'default': 0.00 },   // free
  'aws_ce_anomaly_monitor':                    { 'default': 0.00 },   // free (per alert cost)
  'aws_fis_experiment_template':               { 'default': 0.00 },   // EC2 costs only
  'aws_drs_replication_configuration_template':{ 'default': 50.00 },  // per replicated server

  // Analytics
  'aws_glue_crawler':                          { 'default': 0.44 },   // $0.44/DPU-hr
  'aws_glue_workflow':                         { 'default': 0.00 },   // orchestration only
  'aws_lakeformation_resource':                { 'default': 0.00 },   // free
  'aws_quicksight_data_set':                   { 'default': 18.00 },  // $18/user/mo
  'aws_opensearchserverless_collection':       { 'default': 50.00 },  // OCU-based ~$50 min
  'aws_redshiftserverless_workgroup':          { 'default': 43.00 },  // 8 RPU ~$43/hr active

  // App Integration
  'aws_ses_configuration_set':                 { 'default': 0.00 },   // free
  'aws_pinpoint_app':                          { 'default': 0.00 },   // usage-based
  'aws_appflow_flow':                          { 'default': 0.00 },   // $0.001/flow run
  'aws_cognito_user_pool_client':              { 'default': 0.00 },   // free
  'aws_cloudwatch_event_api_destination':      { 'default': 0.00 },   // usage-based

  // Machine Learning
  'aws_sagemaker_domain':                      { 'default': 0.00 },   // Studio usage-based
  'aws_sagemaker_pipeline':                    { 'default': 0.00 },   // compute-based
  'aws_sagemaker_feature_group':               { 'default': 0.00 },   // storage-based
  'aws_rekognition_collection':                { 'default': 0.00 },   // per API call
  'aws_comprehend_entity_recognizer':          { 'default': 0.00 },   // per inference
  'aws_bedrock_custom_model':                  { 'default': 0.00 },   // training + inference
};

function getStaticCost(resourceType, config = {}) {
  const table = STATIC_COSTS[resourceType];
  if (!table) return null; // Free or unknown
  const instanceType = config.instance_type || config.node_type || config.cache_node_type
                    || config.volume_type || 'default';
  return table[instanceType] ?? table['default'] ?? null;
}

/**
 * Extract all resource blocks from HCL using brace-depth tracking.
 * The regex approach (/[\s\S]+?)^}/) fails on resources that contain nested
 * blocks with their own closing braces (lifecycle {}, tags {}, etc.).
 * This function correctly handles arbitrary nesting depth.
 *
 * Returns an array of { resourceType, resourceName, body } objects where
 * body is the text between (not including) the outer braces of the block.
 */
function extractAllResourceBlocks(hcl) {
  const blocks = [];
  const headerRe = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
  let headerMatch;
  while ((headerMatch = headerRe.exec(hcl)) !== null) {
    const resourceType = headerMatch[1];
    const resourceName = headerMatch[2];
    // Start just after the opening brace
    let depth = 1;
    let i = headerMatch.index + headerMatch[0].length;
    const bodyStart = i;
    while (i < hcl.length && depth > 0) {
      const ch = hcl[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    // Slice excludes the final closing brace (depth hit 0 at i-1)
    const body = hcl.slice(bodyStart, i - 1);
    blocks.push({ resourceType, resourceName, body });
  }
  return blocks;
}

function estimateStatic(hcl) {
  const items = [];
  let total = 0;

  // Use brace-depth extraction so nested blocks (lifecycle {}, tags {}, etc.)
  // do not prematurely truncate the captured body, which previously caused
  // instance_type and other key lookups to fail on real-world HCL.
  const blocks = extractAllResourceBlocks(hcl);
  for (const { resourceType, resourceName, body } of blocks) {
    // Extract simple key = "value" and key = number pairs from block body
    const config = {};
    const kvRe = /^\s*(\w+)\s*=\s*["']?([^"'\n]+?)["']?\s*$/gm;
    let kv;
    while ((kv = kvRe.exec(body)) !== null) {
      config[kv[1]] = kv[2].trim();
    }
    const cost = getStaticCost(resourceType, config);
    items.push({
      resource:    `${resourceType}.${resourceName}`,
      monthly_usd: cost,
      note: cost === 0 ? 'Usage-based' : cost === null ? 'Not estimated' : null,
    });
    if (cost && cost > 0) total += cost;
  }

  return { engine: 'static', total_monthly_usd: Math.round(total * 100) / 100, items };
}

// ─── Docker Infracost runner ───────────────────────────────────────────────────
async function runInfracost(hcl) {
  const useDocker = await isDockerAvailable();

  if (!useDocker || !INFRACOST_API_KEY) {
    return { ...estimateStatic(hcl), offline: !useDocker, no_api_key: !INFRACOST_API_KEY };
  }

  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');

  const dockerCmd = [
    'docker run --rm',
    '--network=bridge --memory=256m --cpus=0.5',
    '-e', `INFRACOST_API_KEY=${INFRACOST_API_KEY}`,
    `-v "${workDir}":/workspace:ro`,
    INFRACOST_IMAGE,
    'breakdown', '--path', '/workspace',
    '--format', 'json', '--no-cache',
  ].join(' ');

  return new Promise(resolve => {
    exec(dockerCmd, { timeout: 60000 }, (_, stdout, stderr) => {
      cleanup(workDir);
      try {
        const data = JSON.parse(stdout);
        const projects = data.projects || [];
        const items = [];
        let total = 0;
        for (const proj of projects) {
          for (const res of proj.breakdown?.resources || []) {
            const cost = res.monthlyCost ? parseFloat(res.monthlyCost) : 0;
            total += cost;
            items.push({ resource: res.name, monthly_usd: Math.round(cost * 100) / 100 });
          }
        }
        resolve({ engine: 'infracost', total_monthly_usd: Math.round(total * 100) / 100, items });
      } catch (_) {
        console.warn('[infracost] Could not parse Infracost JSON, falling back to static estimates');
        resolve({ ...estimateStatic(hcl), offline: true });
      }
    });
  });
}

module.exports = { runInfracost, estimateStatic };
