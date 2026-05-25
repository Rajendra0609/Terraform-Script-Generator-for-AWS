'use strict';
/**
 * /api/state — Terraform State Inspector
 * POST /api/state/inspect  — parse .tfstate JSON, detect drift vs builder config
 */
const router = require('express').Router();
const { optionalAuth } = require('../middleware/auth');

const TYPE_MAP = {
  // ── Compute ────────────────────────────────────────────────────────────────
  aws_instance:'ec2', aws_autoscaling_group:'auto_scaling_group',
  aws_launch_template:'launch_template', aws_lambda_function:'lambda',
  aws_elastic_beanstalk_environment:'elastic_beanstalk', aws_spot_fleet_request:'spot_fleet',
  // new v9
  aws_key_pair:'key_pair',
  aws_imagebuilder_image_pipeline:'image_builder_pipeline',
  aws_apprunner_service:'apprunner_service',
  aws_batch_compute_environment:'batch_compute_environment',
  aws_lambda_layer_version:'lambda_layer_version',
  aws_lambda_function_url:'lambda_function_url',
  aws_lambda_event_source_mapping:'lambda_event_source_mapping',

  // ── Storage ────────────────────────────────────────────────────────────────
  aws_s3_bucket:'s3', aws_ebs_volume:'ebs_volume', aws_efs_file_system:'efs',
  aws_fsx_lustre_file_system:'fsx', aws_datasync_task:'datasync_task',
  // new v9
  aws_s3_bucket_policy:'s3_bucket_policy',
  aws_transfer_server:'transfer_server',
  aws_backup_vault:'backup_vault',
  aws_storagegateway_gateway:'storage_gateway',

  // ── Networking ────────────────────────────────────────────────────────────
  aws_vpc:'vpc', aws_subnet:'subnet', aws_security_group:'security_group',
  aws_internet_gateway:'internet_gateway', aws_nat_gateway:'nat_gateway',
  aws_route_table:'route_table', aws_route53_zone:'route53_zone',
  aws_cloudfront_distribution:'cloudfront', aws_vpc_peering_connection:'vpc_peering',
  aws_eip:'elastic_ip', aws_network_acl:'network_acl', aws_vpc_endpoint:'vpc_endpoint',
  aws_customer_gateway:'customer_gateway', aws_vpn_connection:'vpn_connection',
  aws_dx_gateway:'direct_connect_gateway',
  aws_alb:'alb', aws_lb:'alb',
  aws_flow_log:'vpc_flow_logs', aws_globalaccelerator_accelerator:'global_accelerator',
  aws_networkfirewall_firewall:'network_firewall',
  aws_ec2_transit_gateway:'transit_gateway',
  // new v9
  aws_route53_record:'route53_record',
  aws_route53_resolver_endpoint:'route53_resolver_endpoint',
  aws_route53_resolver_rule:'route53_resolver_rule',
  aws_route53_traffic_policy:'route53_traffic_policy',
  aws_lb_target_group:'alb_target_group',
  aws_lb_listener:'alb_listener',
  aws_lb_listener_rule:'alb_listener_rule',
  aws_vpc_ipam:'vpc_ipam',
  aws_vpc_ipam_pool:'vpc_ipam_pool',

  // ── Database ──────────────────────────────────────────────────────────────
  aws_db_instance:'rds', aws_dynamodb_table:'dynamodb',
  aws_elasticache_cluster:'elasticache', aws_rds_cluster:'aurora_cluster',
  aws_redshift_cluster:'redshift_cluster', aws_opensearch_domain:'opensearch_domain',
  aws_docdb_cluster:'documentdb_cluster', aws_db_proxy:'rds_proxy',
  aws_timestreamwrite_database:'timestream_database',
  // new v9
  aws_db_subnet_group:'db_subnet_group',
  aws_db_parameter_group:'db_parameter_group',
  aws_dax_cluster:'dax_cluster',
  aws_neptune_cluster:'neptune_cluster',
  aws_memorydb_cluster:'memorydb_cluster',
  aws_keyspaces_table:'keyspaces_table',

  // ── IAM & Security ────────────────────────────────────────────────────────
  aws_iam_role:'iam_role', aws_iam_user:'iam_user', aws_iam_policy:'iam_policy',
  aws_iam_group:'iam_group', aws_kms_key:'kms_key',
  aws_secretsmanager_secret:'secrets_manager', aws_acm_certificate:'acm_certificate',
  aws_securityhub_account:'security_hub', aws_macie2_account:'macie',
  aws_inspector2_enabler:'inspector2',
  aws_iam_openid_connect_provider:'iam_oidc_provider',
  // new v9
  aws_accessanalyzer_analyzer:'iam_access_analyzer',
  aws_shield_protection:'shield_protection',
  aws_fms_policy:'fms_policy',
  aws_ssoadmin_permission_set:'ssoadmin_instance',
  aws_ram_resource_share:'ram_resource_share',
  aws_directory_service_directory:'directory_service_directory',
  aws_cognito_identity_pool:'cognito_identity_pool',
  aws_acmpca_certificate_authority:'acmpca_certificate_authority',
  aws_verifiedaccess_instance:'verifiedaccess_instance',

  // ── Monitoring ────────────────────────────────────────────────────────────
  aws_cloudwatch_metric_alarm:'cloudwatch_alarm',
  aws_cloudwatch_log_group:'cloudwatch_log_group',
  aws_sns_topic:'sns_topic', aws_sqs_queue:'sqs_queue',
  aws_cloudwatch_event_rule:'eventbridge_rule',
  aws_cloudwatch_dashboard:'cloudwatch_dashboard',
  aws_xray_group:'xray_group',
  aws_prometheus_workspace:'prometheus_workspace',
  aws_grafana_workspace:'grafana_workspace',
  // new v9
  aws_cloudwatch_composite_alarm:'cloudwatch_composite_alarm',
  aws_synthetics_canary:'synthetics_canary',
  aws_cloudwatch_metric_stream:'cloudwatch_metric_stream',
  aws_rum_app_monitor:'rum_app_monitor',
  aws_pipes_pipe:'pipes_pipe',
  aws_scheduler_schedule:'scheduler_schedule',
  aws_devopsguru_resource_collection:'devopsguru_resource_collection',
  aws_chatbot_slack_channel_configuration:'chatbot_slack_channel_configuration',

  // ── Containers ────────────────────────────────────────────────────────────
  aws_eks_cluster:'eks', aws_ecs_cluster:'ecs_cluster',
  aws_ecr_repository:'ecr_repository', aws_ecs_task_definition:'ecs_task_definition',
  aws_ecs_service:'ecs_service', aws_eks_node_group:'eks_node_group',
  aws_eks_fargate_profile:'eks_fargate_profile',
  // new v9
  aws_eks_addon:'eks_addon',
  aws_appmesh_mesh:'appmesh_mesh',
  aws_ecr_lifecycle_policy:'ecr_lifecycle_policy',
  aws_ecs_capacity_provider:'ecs_capacity_provider',
  aws_eks_identity_provider_config:'eks_identity_provider_config',
  aws_ecrpublic_repository:'ecrpublic_repository',

  // ── CI/CD ─────────────────────────────────────────────────────────────────
  aws_codepipeline:'codepipeline', aws_codebuild_project:'codebuild',
  aws_codedeploy_app:'codedeploy', aws_api_gateway_rest_api:'api_gateway',
  aws_codecommit_repository:'codecommit', aws_codeartifact_domain:'codeartifact',
  aws_apigatewayv2_api:'api_gateway_v2', aws_amplify_app:'amplify_app',
  // new v9
  aws_codestarconnections_connection:'codestarconnections_connection',
  aws_api_gateway_domain_name:'api_gateway_domain_name',
  aws_api_gateway_stage:'api_gateway_stage',
  aws_appconfig_application:'appconfig_application',
  aws_cloud9_environment_ec2:'cloud9_environment_ec2',
  aws_codegurureviewer_repository_association:'codegurureviewer_repository_association',
  aws_servicecatalog_portfolio:'servicecatalog_portfolio',

  // ── Admin & Ops ───────────────────────────────────────────────────────────
  aws_ssm_parameter:'ssm_parameter', aws_backup_plan:'aws_backup',
  aws_cloudtrail:'cloudtrail', aws_guardduty_detector:'guardduty',
  aws_wafv2_web_acl:'waf', aws_budgets_budget:'budgets',
  aws_config_config_rule:'config_rule',
  aws_ssm_patch_baseline:'ssm_patch_baseline',
  aws_sesv2_email_identity:'ses_email_identity',
  aws_organizations_account:'organizations_account',
  aws_organizations_policy:'service_control_policy',
  aws_config_conformance_pack:'config_conformance_pack',
  aws_ssm_maintenance_window:'ssm_maintenance_window',
  aws_route53_health_check:'route53_health_check',
  // new v9
  aws_cloudformation_stack:'cloudformation_stack',
  aws_resourcegroups_group:'resourcegroups_group',
  aws_ce_anomaly_monitor:'ce_anomaly_monitor',
  aws_fis_experiment_template:'fis_experiment_template',
  aws_drs_replication_configuration_template:'drs_replication_configuration_template',

  // ── Analytics ─────────────────────────────────────────────────────────────
  aws_kinesis_stream:'kinesis_stream',
  aws_kinesis_firehose_delivery_stream:'kinesis_firehose',
  aws_glue_job:'glue_job', aws_glue_catalog_database:'glue_catalog_database',
  aws_athena_workgroup:'athena_workgroup', aws_msk_cluster:'msk_cluster',
  aws_emr_cluster:'emr_cluster',
  // new v9
  aws_glue_crawler:'glue_crawler',
  aws_glue_workflow:'glue_workflow',
  aws_lakeformation_resource:'lakeformation_resource',
  aws_quicksight_data_set:'quicksight_data_set',
  aws_opensearchserverless_collection:'opensearchserverless_collection',
  aws_redshiftserverless_workgroup:'redshift_serverless_workgroup',

  // ── App Integration ───────────────────────────────────────────────────────
  aws_sfn_state_machine:'step_functions', aws_appsync_graphql_api:'appsync',
  aws_mq_broker:'mq_broker', aws_cloudwatch_event_bus:'eventbridge_bus',
  aws_cognito_user_pool:'cognito_user_pool',
  // new v9
  aws_ses_configuration_set:'ses_configuration_set',
  aws_pinpoint_app:'pinpoint_app',
  aws_appflow_flow:'appflow_flow',
  aws_cognito_user_pool_client:'cognito_user_pool_client',
  aws_cloudwatch_event_api_destination:'cloudwatch_event_api_destination',

  // ── Machine Learning ──────────────────────────────────────────────────────
  aws_sagemaker_notebook_instance:'sagemaker_notebook',
  aws_sagemaker_endpoint:'sagemaker_endpoint',
  aws_bedrock_model_invocation_logging_configuration:'bedrock_model_invocation',
  // new v9
  aws_sagemaker_domain:'sagemaker_domain',
  aws_sagemaker_pipeline:'sagemaker_pipeline',
  aws_sagemaker_feature_group:'sagemaker_feature_group',
  aws_rekognition_collection:'rekognition_collection',
  aws_comprehend_entity_recognizer:'comprehend_entity_recognizer',
  aws_bedrock_custom_model:'bedrock_custom_model',
};

const KEY_ATTRS = {
  aws_instance:['instance_type','ami','availability_zone','private_ip','public_ip','key_name','vpc_id','subnet_id','state'],
  aws_vpc:['cidr_block','state','enable_dns_hostnames','enable_dns_support','instance_tenancy'],
  aws_subnet:['cidr_block','availability_zone','map_public_ip_on_launch','vpc_id','available_ip_address_count'],
  aws_security_group:['name','vpc_id','description'],
  aws_s3_bucket:['bucket','region','bucket_domain_name'],
  aws_db_instance:['engine','engine_version','instance_class','allocated_storage','multi_az','endpoint','port','status'],
  aws_lambda_function:['function_name','runtime','handler','memory_size','timeout','last_modified','code_size'],
  aws_iam_role:['name','path','create_date','unique_id','arn'],
  aws_alb:['name','scheme','load_balancer_type','dns_name','state'],
  aws_lb:['name','scheme','load_balancer_type','dns_name','state'],
  aws_eks_cluster:['name','version','status','endpoint','role_arn'],
  aws_dynamodb_table:['name','billing_mode','hash_key','range_key','table_status'],
  aws_nat_gateway:['subnet_id','allocation_id','public_ip','state'],
  aws_cloudfront_distribution:['domain_name','status','enabled','price_class','http_version'],
  aws_sns_topic:['name','arn'],
  aws_sqs_queue:['name','url','fifo_queue','visibility_timeout_seconds'],
  aws_elasticache_cluster:['cluster_id','engine','node_type','num_cache_nodes','port'],
};

function extractAttrs(resourceType, attrs) {
  const keys = KEY_ATTRS[resourceType] || Object.keys(attrs).filter(k => typeof attrs[k] !== 'object').slice(0, 10);
  const out = {};
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== '') {
      out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v);
    }
  }
  return out;
}

function parseTfState(stateJson) {
  const resources = [];
  const warnings = [];
  const version = stateJson.version || 0;
  if (version < 3 || version > 4) {
    warnings.push(`State version ${version} — expected 3 or 4. Some fields may be missing.`);
  }
  for (const res of (stateJson.resources || [])) {
    if (res.mode === 'data') continue;
    for (const inst of (res.instances || [])) {
      const attrs = inst.attributes || {};
      resources.push({
        id: attrs.id || `${res.type}.${res.name}`,
        type: res.type,
        service_type: TYPE_MAP[res.type] || res.type.replace('aws_',''),
        name: res.name,
        module: res.module || null,
        provider: (res.provider || '').replace(/.*provider\["|"\]/g,''),
        region: attrs.region || (attrs.availability_zone||'').slice(0,-1) || null,
        arn: attrs.arn || null,
        tags: attrs.tags || attrs.tags_all || {},
        key_attrs: extractAttrs(res.type, attrs),
        tainted: inst.status === 'tainted',
        deposed: !!inst.deposed_key,
        index_key: inst.index_key ?? null,
      });
    }
  }
  return { resources, warnings, version, terraform_version: stateJson.terraform_version || null, serial: stateJson.serial || null };
}

function computeDrift(stateResources, configResources) {
  const drift = [];

  // Build a lookup: "aws_type.name" → state resource
  const stateMap = new Map();
  for (const sr of stateResources) {
    stateMap.set(`${sr.type}.${sr.name}`, sr);
  }

  // Build config lookup by service_type.label
  const configSet = new Set();
  for (const cr of (configResources || [])) {
    const t = cr.service_type || '';
    const n = cr.resource_name || cr.label || cr.name || '';
    // try both mapped and unmapped
    configSet.add(`${t}.${n}`);
    const awsType = Object.entries(TYPE_MAP).find(([,v]) => v === t)?.[0];
    if (awsType) configSet.add(`${awsType}.${n}`);
  }

  // In state but not in builder config → untracked live infrastructure
  for (const [key, sr] of stateMap) {
    const inConfig = configSet.has(key) || configSet.has(`${sr.service_type}.${sr.name}`);
    if (!inConfig) {
      drift.push({
        type: 'untracked', severity: 'warning',
        resource: `${sr.type}.${sr.name}`,
        message: `Live resource not in builder — consider using terraform import`,
        arn: sr.arn, tags: sr.tags, key_attrs: sr.key_attrs,
      });
    }
  }

  // In builder config but not in state → will be created
  for (const cr of (configResources || [])) {
    const t = cr.service_type || '';
    const n = cr.resource_name || cr.label || cr.name || '';
    const awsType = Object.entries(TYPE_MAP).find(([,v]) => v === t)?.[0] || t;
    const key1 = `${awsType}.${n}`;
    const key2 = `${t}.${n}`;
    if (!stateMap.has(key1) && !stateMap.has(key2)) {
      drift.push({
        type: 'planned', severity: 'info',
        resource: `${awsType}.${n}`,
        message: `In builder config but not yet deployed — will be created on next apply`,
        service_type: t,
      });
    }
  }

  // Tainted
  for (const sr of stateResources) {
    if (sr.tainted) drift.push({ type: 'tainted', severity: 'error', resource: `${sr.type}.${sr.name}`, message: 'TAINTED — will be destroyed and recreated on next apply' });
  }
  // Deposed
  for (const sr of stateResources) {
    if (sr.deposed) drift.push({ type: 'deposed', severity: 'error', resource: `${sr.type}.${sr.name}`, message: 'Deposed instance — previous apply may have failed mid-destroy' });
  }

  return drift;
}

router.post('/inspect', optionalAuth, (req, res) => {
  const { state, config_resources } = req.body;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'state must be the parsed JSON of your terraform.tfstate file' });
  }
  try {
    const parsed = parseTfState(state);
    const drift  = computeDrift(parsed.resources, config_resources || []);
    const grouped = {};
    for (const r of parsed.resources) {
      (grouped[r.service_type] = grouped[r.service_type] || []).push(r);
    }

    // Tag compliance scan
    const REQUIRED_TAGS = ['Name','Environment','Terraform'];
    const tag_issues = parsed.resources
      .filter(r => !r.tainted)
      .map(r => {
        const missing = REQUIRED_TAGS.filter(t => !(r.tags||{})[t]);
        return missing.length ? { resource:`${r.type}.${r.name}`, missing_tags:missing } : null;
      }).filter(Boolean);

    res.json({
      state_version:      parsed.version,
      terraform_version:  parsed.terraform_version,
      serial:             parsed.serial,
      summary: {
        total:     parsed.resources.length,
        tainted:   parsed.resources.filter(r=>r.tainted).length,
        deposed:   parsed.resources.filter(r=>r.deposed).length,
        untracked: drift.filter(d=>d.type==='untracked').length,
        planned:   drift.filter(d=>d.type==='planned').length,
        by_service: Object.fromEntries(Object.entries(grouped).map(([k,v])=>[k,v.length])),
      },
      resources: parsed.resources,
      grouped,
      drift,
      tag_issues,
      warnings: parsed.warnings,
    });
  } catch (e) {
    console.error('[state] parse error:', e.message);
    res.status(400).json({ error: `Failed to parse tfstate: ${e.message}` });
  }
});

module.exports = router;
