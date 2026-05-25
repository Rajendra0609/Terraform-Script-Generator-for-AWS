'use strict';
/**
 * /api/iam — IAM Policy Generator
 * POST /api/iam/generate  Generate minimum IAM policy for a resource/service
 */
const router = require('express').Router();
const { optionalAuth } = require('../middleware/auth');

// Minimum IAM policies per Terraform resource type
const IAM_POLICIES = {
  aws_s3_bucket: {
    name: 'S3 Bucket Management',
    description: 'Minimum policy to create, manage, and destroy an S3 bucket via Terraform',
    statements: [
      { effect: 'Allow', actions: ['s3:CreateBucket','s3:DeleteBucket','s3:GetBucketAcl','s3:GetBucketCORS','s3:GetBucketLogging','s3:GetBucketNotification','s3:GetBucketPolicy','s3:GetBucketPublicAccessBlock','s3:GetBucketRequestPayment','s3:GetBucketTagging','s3:GetBucketVersioning','s3:GetBucketWebsite','s3:GetEncryptionConfiguration','s3:GetLifecycleConfiguration','s3:GetReplicationConfiguration','s3:ListBucket','s3:PutBucketAcl','s3:PutBucketCORS','s3:PutBucketLogging','s3:PutBucketNotification','s3:PutBucketPolicy','s3:PutBucketPublicAccessBlock','s3:PutBucketRequestPayment','s3:PutBucketTagging','s3:PutBucketVersioning','s3:PutBucketWebsite','s3:PutEncryptionConfiguration','s3:PutLifecycleConfiguration'], resources: ['arn:aws:s3:::YOUR_BUCKET_NAME','arn:aws:s3:::YOUR_BUCKET_NAME/*'], note: 'Replace YOUR_BUCKET_NAME with the actual bucket name' },
    ],
  },
  aws_instance: {
    name: 'EC2 Instance Management',
    description: 'Minimum policy to launch, manage, and terminate EC2 instances',
    statements: [
      { effect: 'Allow', actions: ['ec2:RunInstances','ec2:TerminateInstances','ec2:StopInstances','ec2:StartInstances','ec2:DescribeInstances','ec2:DescribeInstanceStatus','ec2:DescribeImages','ec2:DescribeVpcs','ec2:DescribeSubnets','ec2:DescribeSecurityGroups','ec2:DescribeKeyPairs','ec2:DescribeInstanceAttribute','ec2:ModifyInstanceAttribute','ec2:CreateTags','ec2:DeleteTags','ec2:DescribeTags'], resources: ['*'], note: 'Scope resources to specific regions or instance IDs in production' },
      { effect: 'Allow', actions: ['iam:PassRole'], resources: ['arn:aws:iam::ACCOUNT_ID:role/*'], note: 'Required if attaching an instance profile; scope to specific role ARNs' },
    ],
  },
  aws_vpc: {
    name: 'VPC Management',
    description: 'Minimum policy to create and manage VPCs and associated networking resources',
    statements: [
      { effect: 'Allow', actions: ['ec2:CreateVpc','ec2:DeleteVpc','ec2:DescribeVpcs','ec2:ModifyVpcAttribute','ec2:CreateSubnet','ec2:DeleteSubnet','ec2:DescribeSubnets','ec2:ModifySubnetAttribute','ec2:CreateInternetGateway','ec2:DeleteInternetGateway','ec2:AttachInternetGateway','ec2:DetachInternetGateway','ec2:DescribeInternetGateways','ec2:CreateRouteTable','ec2:DeleteRouteTable','ec2:DescribeRouteTables','ec2:CreateRoute','ec2:DeleteRoute','ec2:AssociateRouteTable','ec2:DisassociateRouteTable','ec2:CreateNatGateway','ec2:DeleteNatGateway','ec2:DescribeNatGateways','ec2:AllocateAddress','ec2:ReleaseAddress','ec2:DescribeAddresses','ec2:CreateSecurityGroup','ec2:DeleteSecurityGroup','ec2:DescribeSecurityGroups','ec2:AuthorizeSecurityGroupIngress','ec2:AuthorizeSecurityGroupEgress','ec2:RevokeSecurityGroupIngress','ec2:RevokeSecurityGroupEgress','ec2:CreateTags','ec2:DeleteTags'], resources: ['*'] },
    ],
  },
  aws_db_instance: {
    name: 'RDS Instance Management',
    description: 'Minimum policy to create, manage, and destroy RDS database instances',
    statements: [
      { effect: 'Allow', actions: ['rds:CreateDBInstance','rds:DeleteDBInstance','rds:DescribeDBInstances','rds:ModifyDBInstance','rds:RebootDBInstance','rds:CreateDBSubnetGroup','rds:DeleteDBSubnetGroup','rds:DescribeDBSubnetGroups','rds:ModifyDBSubnetGroup','rds:CreateDBParameterGroup','rds:DeleteDBParameterGroup','rds:DescribeDBParameterGroups','rds:ModifyDBParameterGroup','rds:ListTagsForResource','rds:AddTagsToResource','rds:RemoveTagsFromResource','rds:CreateDBSnapshot','rds:DeleteDBSnapshot','rds:DescribeDBSnapshots'], resources: ['*'] },
    ],
  },
  aws_lambda_function: {
    name: 'Lambda Function Management',
    description: 'Minimum policy to deploy and manage Lambda functions',
    statements: [
      { effect: 'Allow', actions: ['lambda:CreateFunction','lambda:DeleteFunction','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:ListFunctions','lambda:AddPermission','lambda:RemovePermission','lambda:GetPolicy','lambda:PublishVersion','lambda:CreateAlias','lambda:DeleteAlias','lambda:UpdateAlias','lambda:ListVersionsByFunction','lambda:ListAliases','lambda:TagResource','lambda:UntagResource','lambda:ListTags','lambda:PutFunctionConcurrency','lambda:DeleteFunctionConcurrency'], resources: ['arn:aws:lambda:REGION:ACCOUNT_ID:function:*'], note: 'Scope to specific function names in production' },
      { effect: 'Allow', actions: ['iam:PassRole'], resources: ['arn:aws:iam::ACCOUNT_ID:role/*'], note: 'Required to pass execution role to Lambda' },
    ],
  },
  aws_eks_cluster: {
    name: 'EKS Cluster Management',
    description: 'Minimum policy to create and manage EKS clusters and node groups',
    statements: [
      { effect: 'Allow', actions: ['eks:CreateCluster','eks:DeleteCluster','eks:DescribeCluster','eks:ListClusters','eks:UpdateClusterConfig','eks:UpdateClusterVersion','eks:TagResource','eks:UntagResource','eks:ListTagsForResource','eks:CreateNodegroup','eks:DeleteNodegroup','eks:DescribeNodegroup','eks:ListNodegroups','eks:UpdateNodegroupConfig','eks:UpdateNodegroupVersion','eks:CreateFargateProfile','eks:DeleteFargateProfile','eks:DescribeFargateProfile','eks:ListFargateProfiles'], resources: ['*'] },
      { effect: 'Allow', actions: ['iam:CreateRole','iam:DeleteRole','iam:GetRole','iam:PassRole','iam:AttachRolePolicy','iam:DetachRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:CreateOpenIDConnectProvider','iam:DeleteOpenIDConnectProvider','iam:GetOpenIDConnectProvider'], resources: ['*'] },
      { effect: 'Allow', actions: ['ec2:DescribeSubnets','ec2:DescribeVpcs','ec2:DescribeSecurityGroups','ec2:DescribeInstances'], resources: ['*'] },
    ],
  },
  aws_iam_role: {
    name: 'IAM Role Management',
    description: 'Minimum policy to create and manage IAM roles and their policies',
    statements: [
      { effect: 'Allow', actions: ['iam:CreateRole','iam:DeleteRole','iam:GetRole','iam:UpdateRole','iam:UpdateRoleDescription','iam:AttachRolePolicy','iam:DetachRolePolicy','iam:PutRolePolicy','iam:DeleteRolePolicy','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:CreateInstanceProfile','iam:DeleteInstanceProfile','iam:GetInstanceProfile','iam:AddRoleToInstanceProfile','iam:RemoveRoleFromInstanceProfile','iam:ListInstanceProfilesForRole','iam:TagRole','iam:UntagRole'], resources: ['arn:aws:iam::ACCOUNT_ID:role/*','arn:aws:iam::ACCOUNT_ID:instance-profile/*'] },
    ],
  },
  aws_alb: {
    name: 'ALB Management',
    description: 'Minimum policy to create and manage Application Load Balancers',
    statements: [
      { effect: 'Allow', actions: ['elasticloadbalancing:CreateLoadBalancer','elasticloadbalancing:DeleteLoadBalancer','elasticloadbalancing:DescribeLoadBalancers','elasticloadbalancing:DescribeLoadBalancerAttributes','elasticloadbalancing:ModifyLoadBalancerAttributes','elasticloadbalancing:CreateTargetGroup','elasticloadbalancing:DeleteTargetGroup','elasticloadbalancing:DescribeTargetGroups','elasticloadbalancing:DescribeTargetGroupAttributes','elasticloadbalancing:ModifyTargetGroupAttributes','elasticloadbalancing:CreateListener','elasticloadbalancing:DeleteListener','elasticloadbalancing:DescribeListeners','elasticloadbalancing:ModifyListener','elasticloadbalancing:CreateRule','elasticloadbalancing:DeleteRule','elasticloadbalancing:DescribeRules','elasticloadbalancing:ModifyRule','elasticloadbalancing:AddTags','elasticloadbalancing:RemoveTags','elasticloadbalancing:DescribeTags'], resources: ['*'] },
    ],
  },
  aws_dynamodb_table: {
    name: 'DynamoDB Table Management',
    description: 'Minimum policy to create and manage DynamoDB tables',
    statements: [
      { effect: 'Allow', actions: ['dynamodb:CreateTable','dynamodb:DeleteTable','dynamodb:DescribeTable','dynamodb:UpdateTable','dynamodb:ListTables','dynamodb:DescribeTimeToLive','dynamodb:UpdateTimeToLive','dynamodb:DescribeContinuousBackups','dynamodb:UpdateContinuousBackups','dynamodb:ListTagsOfResource','dynamodb:TagResource','dynamodb:UntagResource'], resources: ['arn:aws:dynamodb:REGION:ACCOUNT_ID:table/*'] },
    ],
  },
  aws_cloudwatch_alarm: {
    name: 'CloudWatch Alarm Management',
    description: 'Minimum policy to create and manage CloudWatch alarms and metrics',
    statements: [
      { effect: 'Allow', actions: ['cloudwatch:PutMetricAlarm','cloudwatch:DeleteAlarms','cloudwatch:DescribeAlarms','cloudwatch:GetMetricData','cloudwatch:GetMetricStatistics','cloudwatch:ListMetrics','cloudwatch:PutDashboard','cloudwatch:DeleteDashboards'], resources: ['*'] },
    ],
  },
  default: {
    name: 'General Terraform Deployment',
    description: 'Base policy for Terraform state management and general operations',
    statements: [
      { effect: 'Allow', actions: ['s3:GetObject','s3:PutObject','s3:DeleteObject','s3:ListBucket'], resources: ['arn:aws:s3:::YOUR_STATE_BUCKET','arn:aws:s3:::YOUR_STATE_BUCKET/*'], note: 'State bucket access — required for S3 backend' },
      { effect: 'Allow', actions: ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:DeleteItem'], resources: ['arn:aws:dynamodb:REGION:ACCOUNT_ID:table/YOUR_LOCK_TABLE'], note: 'DynamoDB locking table — required for S3 backend with lock' },
      { effect: 'Allow', actions: ['sts:GetCallerIdentity'], resources: ['*'], note: 'Required for provider validation' },
    ],
  },
};

// Map simplified service type names to AWS resource types
const SERVICE_TO_RESOURCE = {
  // ── Compute ────────────────────────────────────────────────────────────────
  ec2: 'aws_instance', auto_scaling_group: 'aws_autoscaling_group',
  alb: 'aws_lb', lambda: 'aws_lambda_function',
  launch_template: 'aws_launch_template', elastic_beanstalk: 'aws_elastic_beanstalk_environment',
  spot_fleet: 'aws_spot_fleet_request',
  // new v9
  key_pair: 'aws_key_pair',
  image_builder_pipeline: 'aws_imagebuilder_image_pipeline',
  apprunner_service: 'aws_apprunner_service',
  batch_compute_environment: 'aws_batch_compute_environment',
  lambda_layer_version: 'aws_lambda_layer_version',
  lambda_function_url: 'aws_lambda_function_url',
  lambda_event_source_mapping: 'aws_lambda_event_source_mapping',

  // ── Storage ────────────────────────────────────────────────────────────────
  s3: 'aws_s3_bucket', ebs_volume: 'aws_ebs_volume', efs: 'aws_efs_file_system',
  fsx: 'aws_fsx_lustre_file_system', datasync_task: 'aws_datasync_task',
  // new v9
  s3_bucket_policy: 'aws_s3_bucket_policy',
  transfer_server: 'aws_transfer_server',
  backup_vault: 'aws_backup_vault',
  storage_gateway: 'aws_storagegateway_gateway',

  // ── Networking ────────────────────────────────────────────────────────────
  vpc: 'aws_vpc', subnet: 'aws_subnet', security_group: 'aws_security_group',
  internet_gateway: 'aws_internet_gateway', nat_gateway: 'aws_nat_gateway',
  route_table: 'aws_route_table', route53_zone: 'aws_route53_zone',
  cloudfront: 'aws_cloudfront_distribution', vpc_peering: 'aws_vpc_peering_connection',
  elastic_ip: 'aws_eip', network_acl: 'aws_network_acl', vpc_endpoint: 'aws_vpc_endpoint',
  customer_gateway: 'aws_customer_gateway', vpn_connection: 'aws_vpn_connection',
  direct_connect_gateway: 'aws_dx_gateway', network_load_balancer: 'aws_lb',
  vpc_flow_logs: 'aws_flow_log', global_accelerator: 'aws_globalaccelerator_accelerator',
  network_firewall: 'aws_networkfirewall_firewall',
  // new v9
  route53_record: 'aws_route53_record',
  route53_resolver_endpoint: 'aws_route53_resolver_endpoint',
  route53_resolver_rule: 'aws_route53_resolver_rule',
  route53_traffic_policy: 'aws_route53_traffic_policy',
  alb_target_group: 'aws_lb_target_group',
  alb_listener: 'aws_lb_listener',
  alb_listener_rule: 'aws_lb_listener_rule',
  gateway_load_balancer: 'aws_lb',
  vpc_ipam: 'aws_vpc_ipam',
  vpc_ipam_pool: 'aws_vpc_ipam_pool',

  // ── Database ──────────────────────────────────────────────────────────────
  rds: 'aws_db_instance', dynamodb: 'aws_dynamodb_table',
  elasticache: 'aws_elasticache_cluster', aurora_cluster: 'aws_rds_cluster',
  redshift_cluster: 'aws_redshift_cluster', opensearch_domain: 'aws_opensearch_domain',
  documentdb_cluster: 'aws_docdb_cluster', rds_proxy: 'aws_db_proxy',
  timestream_database: 'aws_timestreamwrite_database',
  // new v9
  db_subnet_group: 'aws_db_subnet_group',
  db_parameter_group: 'aws_db_parameter_group',
  dynamodb_global_table: 'aws_dynamodb_table',
  dax_cluster: 'aws_dax_cluster',
  neptune_cluster: 'aws_neptune_cluster',
  memorydb_cluster: 'aws_memorydb_cluster',
  keyspaces_table: 'aws_keyspaces_table',

  // ── IAM & Security ────────────────────────────────────────────────────────
  iam_role: 'aws_iam_role', iam_user: 'aws_iam_user', iam_policy: 'aws_iam_policy',
  iam_group: 'aws_iam_group', kms_key: 'aws_kms_key',
  secrets_manager: 'aws_secretsmanager_secret', acm_certificate: 'aws_acm_certificate',
  security_hub: 'aws_securityhub_account', macie: 'aws_macie2_account',
  inspector2: 'aws_inspector2_enabler', iam_oidc_provider: 'aws_iam_openid_connect_provider',
  // new v9
  iam_access_analyzer: 'aws_accessanalyzer_analyzer',
  shield_protection: 'aws_shield_protection',
  fms_policy: 'aws_fms_policy',
  ssoadmin_instance: 'aws_ssoadmin_permission_set',
  ram_resource_share: 'aws_ram_resource_share',
  directory_service_directory: 'aws_directory_service_directory',
  cognito_identity_pool: 'aws_cognito_identity_pool',
  acmpca_certificate_authority: 'aws_acmpca_certificate_authority',
  verifiedaccess_instance: 'aws_verifiedaccess_instance',

  // ── Monitoring ────────────────────────────────────────────────────────────
  cloudwatch_alarm: 'aws_cloudwatch_metric_alarm',
  cloudwatch_log_group: 'aws_cloudwatch_log_group',
  sns_topic: 'aws_sns_topic', sqs_queue: 'aws_sqs_queue',
  eventbridge_rule: 'aws_cloudwatch_event_rule',
  cloudwatch_dashboard: 'aws_cloudwatch_dashboard',
  xray_group: 'aws_xray_group', prometheus_workspace: 'aws_prometheus_workspace',
  grafana_workspace: 'aws_grafana_workspace',
  // new v9
  cloudwatch_composite_alarm: 'aws_cloudwatch_composite_alarm',
  synthetics_canary: 'aws_synthetics_canary',
  cloudwatch_metric_stream: 'aws_cloudwatch_metric_stream',
  rum_app_monitor: 'aws_rum_app_monitor',
  pipes_pipe: 'aws_pipes_pipe',
  scheduler_schedule: 'aws_scheduler_schedule',
  devopsguru_resource_collection: 'aws_devopsguru_resource_collection',
  chatbot_slack_channel_configuration: 'aws_chatbot_slack_channel_configuration',

  // ── Containers ────────────────────────────────────────────────────────────
  eks: 'aws_eks_cluster', ecs_cluster: 'aws_ecs_cluster',
  ecr_repository: 'aws_ecr_repository', ecs_task_definition: 'aws_ecs_task_definition',
  ecs_service: 'aws_ecs_service', eks_node_group: 'aws_eks_node_group',
  eks_fargate_profile: 'aws_eks_fargate_profile',
  // new v9
  eks_addon: 'aws_eks_addon',
  appmesh_mesh: 'aws_appmesh_mesh',
  ecr_lifecycle_policy: 'aws_ecr_lifecycle_policy',
  ecs_capacity_provider: 'aws_ecs_capacity_provider',
  eks_identity_provider_config: 'aws_eks_identity_provider_config',
  ecrpublic_repository: 'aws_ecrpublic_repository',

  // ── CI/CD ─────────────────────────────────────────────────────────────────
  codepipeline: 'aws_codepipeline', codebuild: 'aws_codebuild_project',
  codedeploy: 'aws_codedeploy_app', api_gateway: 'aws_api_gateway_rest_api',
  codecommit: 'aws_codecommit_repository', codeartifact: 'aws_codeartifact_domain',
  api_gateway_v2: 'aws_apigatewayv2_api', amplify_app: 'aws_amplify_app',
  // new v9
  codestarconnections_connection: 'aws_codestarconnections_connection',
  api_gateway_domain_name: 'aws_api_gateway_domain_name',
  api_gateway_stage: 'aws_api_gateway_stage',
  appconfig_application: 'aws_appconfig_application',
  cloud9_environment_ec2: 'aws_cloud9_environment_ec2',
  codegurureviewer_repository_association: 'aws_codegurureviewer_repository_association',
  servicecatalog_portfolio: 'aws_servicecatalog_portfolio',

  // ── Admin & Ops ───────────────────────────────────────────────────────────
  ssm_parameter: 'aws_ssm_parameter', aws_backup: 'aws_backup_plan',
  cloudtrail: 'aws_cloudtrail', guardduty: 'aws_guardduty_detector',
  waf: 'aws_wafv2_web_acl', budgets: 'aws_budgets_budget',
  config_rule: 'aws_config_config_rule', transit_gateway: 'aws_ec2_transit_gateway',
  ssm_patch_baseline: 'aws_ssm_patch_baseline', ses_email_identity: 'aws_sesv2_email_identity',
  organizations_account: 'aws_organizations_account',
  service_control_policy: 'aws_organizations_policy',
  config_conformance_pack: 'aws_config_conformance_pack',
  ssm_maintenance_window: 'aws_ssm_maintenance_window',
  route53_health_check: 'aws_route53_health_check',
  // new v9
  cloudformation_stack: 'aws_cloudformation_stack',
  resourcegroups_group: 'aws_resourcegroups_group',
  ce_anomaly_monitor: 'aws_ce_anomaly_monitor',
  fis_experiment_template: 'aws_fis_experiment_template',
  drs_replication_configuration_template: 'aws_drs_replication_configuration_template',

  // ── Analytics ─────────────────────────────────────────────────────────────
  kinesis_stream: 'aws_kinesis_stream', kinesis_firehose: 'aws_kinesis_firehose_delivery_stream',
  glue_job: 'aws_glue_job', glue_catalog_database: 'aws_glue_catalog_database',
  athena_workgroup: 'aws_athena_workgroup', msk_cluster: 'aws_msk_cluster',
  emr_cluster: 'aws_emr_cluster',
  // new v9
  glue_crawler: 'aws_glue_crawler',
  glue_workflow: 'aws_glue_workflow',
  lakeformation_resource: 'aws_lakeformation_resource',
  quicksight_data_set: 'aws_quicksight_data_set',
  opensearchserverless_collection: 'aws_opensearchserverless_collection',
  redshift_serverless_workgroup: 'aws_redshiftserverless_workgroup',

  // ── App Integration ───────────────────────────────────────────────────────
  step_functions: 'aws_sfn_state_machine', appsync: 'aws_appsync_graphql_api',
  mq_broker: 'aws_mq_broker', eventbridge_bus: 'aws_cloudwatch_event_bus',
  cognito_user_pool: 'aws_cognito_user_pool',
  // new v9
  ses_configuration_set: 'aws_ses_configuration_set',
  pinpoint_app: 'aws_pinpoint_app',
  appflow_flow: 'aws_appflow_flow',
  cognito_user_pool_client: 'aws_cognito_user_pool_client',
  cloudwatch_event_api_destination: 'aws_cloudwatch_event_api_destination',
  sqs_queue_redrive_policy: 'aws_sqs_queue',

  // ── Machine Learning ──────────────────────────────────────────────────────
  sagemaker_notebook: 'aws_sagemaker_notebook_instance',
  sagemaker_endpoint: 'aws_sagemaker_endpoint',
  bedrock_model_invocation: 'aws_bedrock_model_invocation_logging_configuration',
  // new v9
  sagemaker_domain: 'aws_sagemaker_domain',
  sagemaker_pipeline: 'aws_sagemaker_pipeline',
  sagemaker_feature_group: 'aws_sagemaker_feature_group',
  rekognition_collection: 'aws_rekognition_collection',
  comprehend_entity_recognizer: 'aws_comprehend_entity_recognizer',
  bedrock_custom_model: 'aws_bedrock_custom_model',
};

function formatPolicy(statements) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: statements.map((s, i) => ({
      Sid: `Statement${i + 1}`,
      Effect: s.effect,
      Action: s.actions,
      Resource: s.resources,
    })),
  }, null, 2);
}

router.post('/generate', optionalAuth, (req, res) => {
  const { service_type, resource_type } = req.body;
  if (!service_type && !resource_type) {
    return res.status(400).json({ error: 'service_type or resource_type required' });
  }

  const rt = resource_type || SERVICE_TO_RESOURCE[service_type] || 'default';
  const policy = IAM_POLICIES[rt] || IAM_POLICIES.default;

  res.json({
    resource_type: rt,
    service_type: service_type || rt,
    ...policy,
    policy_json: formatPolicy(policy.statements),
    notes: [
      'This is the minimum policy for Terraform to manage this resource.',
      'Replace ACCOUNT_ID, REGION, and placeholder names with your actual values.',
      'Consider using IAM permission boundaries in multi-team environments.',
      'Regularly audit and rotate the credentials attached to this policy.',
    ],
  });
});

// Batch: generate for multiple services at once
router.post('/generate/batch', optionalAuth, (req, res) => {
  const { service_types = [] } = req.body;
  if (!Array.isArray(service_types) || service_types.length === 0) {
    return res.status(400).json({ error: 'service_types array required' });
  }

  const results = service_types.map(st => {
    const rt = SERVICE_TO_RESOURCE[st] || 'default';
    const policy = IAM_POLICIES[rt] || IAM_POLICIES.default;
    return { service_type: st, resource_type: rt, name: policy.name, statements: policy.statements };
  });

  // Merge all statements into one policy
  const allStatements = results.flatMap(r => r.statements);
  const mergedActions = {};
  allStatements.forEach(s => {
    const key = s.resources.join(',');
    if (!mergedActions[key]) mergedActions[key] = new Set();
    s.actions.forEach(a => mergedActions[key].add(a));
  });

  const mergedStatements = Object.entries(mergedActions).map(([resources, actions]) => ({
    effect: 'Allow',
    actions: [...actions].sort(),
    resources: resources.split(','),
  }));

  res.json({
    services: service_types,
    breakdown: results,
    merged_policy_json: formatPolicy(mergedStatements),
    notes: [
      'Merged policy for all selected services.',
      'Review and scope Resource ARNs before attaching in production.',
      'Consider splitting into service-specific roles for least privilege.',
    ],
  });
});

module.exports = router;
