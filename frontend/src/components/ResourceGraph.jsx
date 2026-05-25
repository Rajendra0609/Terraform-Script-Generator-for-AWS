import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { connectByEdge, disconnectEdge } from '../utils/dependencyWiring';

// --- Service metadata (color, icon, display label, semantic layout layer) -----
// layer: 0=internet-edge  1=VPC  2=network(subnet/RT/NAT)  3=compute  4=services  5=security
const SERVICE_META = {
  // -- Networking / Edge ------------------------------------------------------
  vpc:                          { color: '#6366f1', icon: '🧭', label: 'VPC',           layer: 1 },
  subnet:                       { color: '#0ea5e9', icon: '📡', label: 'Subnet',         layer: 2 },
  security_group:               { color: '#f59e0b', icon: '🔒', label: 'SG',             layer: 5 },
  internet_gateway:             { color: '#94a3b8', icon: '🌐', label: 'IGW',            layer: 0 },
  igw:                          { color: '#94a3b8', icon: '🌐', label: 'IGW',            layer: 0 },
  nat_gateway:                  { color: '#84cc16', icon: '🛣️', label: 'NAT',            layer: 2 },
  route_table:                  { color: '#a78bfa', icon: '🗺️', label: 'RT',             layer: 2 },
  eip:                          { color: '#fb923c', icon: '📡', label: 'EIP',            layer: 0 },
  elastic_ip:                   { color: '#fb923c', icon: '📡', label: 'EIP',            layer: 0 },
  cloudfront:                   { color: '#7c3aed', icon: '🚀', label: 'CF',             layer: 0 },
  route53_zone:                 { color: '#b45309', icon: '🧭', label: 'R53 Zone',       layer: 0 },
  route53:                      { color: '#b45309', icon: '🧭', label: 'R53',            layer: 0 },
  vpc_peering:                  { color: '#818cf8', icon: '🔗', label: 'Peering',        layer: 1 },
  network_acl:                  { color: '#f59e0b', icon: '🛡️', label: 'NACL',           layer: 2 },
  vpc_endpoint:                 { color: '#38bdf8', icon: '🔌', label: 'VPCE',           layer: 2 },
  customer_gateway:             { color: '#94a3b8', icon: '🏢', label: 'CGW',            layer: 0 },
  vpn_connection:               { color: '#fbbf24', icon: '🔑', label: 'VPN',            layer: 0 },
  direct_connect_gateway:       { color: '#6366f1', icon: '⚡', label: 'DX',             layer: 0 },
  transit_gateway:              { color: '#8b5cf6', icon: '🔀', label: 'TGW',            layer: 1 },
  global_accelerator:           { color: '#06b6d4', icon: '🌍', label: 'GA',             layer: 0 },
  network_firewall:             { color: '#ef4444', icon: '🔥', label: 'NFW',            layer: 2 },
  vpc_flow_logs:                { color: '#64748b', icon: '📋', label: 'FlowLog',        layer: 5 },
  // new v9
  route53_record:               { color: '#b45309', icon: '📝', label: 'DNS Rec',        layer: 0 },
  route53_resolver_endpoint:    { color: '#b45309', icon: '🔍', label: 'Resolver',       layer: 2 },
  route53_resolver_rule:        { color: '#b45309', icon: '📏', label: 'R53 Rule',       layer: 2 },
  route53_traffic_policy:       { color: '#b45309', icon: '⚖️', label: 'Traffic Pol',   layer: 0 },
  alb_target_group:             { color: '#14b8a6', icon: '🎯', label: 'Target Grp',     layer: 3 },
  alb_listener:                 { color: '#14b8a6', icon: '👂', label: 'Listener',       layer: 3 },
  alb_listener_rule:            { color: '#14b8a6', icon: '📐', label: 'LB Rule',        layer: 3 },
  gateway_load_balancer:        { color: '#14b8a6', icon: '🔀', label: 'GWLB',           layer: 3 },
  vpc_ipam:                     { color: '#6366f1', icon: '🗂️', label: 'IPAM',           layer: 1 },
  vpc_ipam_pool:                { color: '#6366f1', icon: '🏊', label: 'IPAM Pool',      layer: 1 },

  // -- Compute ----------------------------------------------------------------
  ec2:                          { color: '#10b981', icon: '🖥️', label: 'EC2',            layer: 3 },
  alb:                          { color: '#14b8a6', icon: '🔀', label: 'ALB',            layer: 3 },
  lambda:                       { color: '#ec4899', icon: '⚡', label: 'Lambda',         layer: 3 },
  auto_scaling_group:           { color: '#059669', icon: '📈', label: 'ASG',            layer: 3 },
  launch_template:              { color: '#34d399', icon: '📄', label: 'LaunchTpl',      layer: 3 },
  elastic_beanstalk:            { color: '#10b981', icon: '🌿', label: 'EB',             layer: 3 },
  spot_fleet:                   { color: '#6ee7b7', icon: '🚢', label: 'Spot Fleet',     layer: 3 },
  // new v9
  key_pair:                     { color: '#fbbf24', icon: '🗝️', label: 'Key Pair',       layer: 5 },
  image_builder_pipeline:       { color: '#818cf8', icon: '🏗️', label: 'Img Builder',   layer: 4 },
  apprunner_service:            { color: '#10b981', icon: '🏃', label: 'App Runner',     layer: 3 },
  batch_compute_environment:    { color: '#059669', icon: '⚙️', label: 'Batch',          layer: 3 },
  lambda_layer_version:         { color: '#ec4899', icon: '🍰', label: 'λ Layer',        layer: 4 },
  lambda_function_url:          { color: '#ec4899', icon: '🔗', label: 'λ URL',          layer: 4 },
  lambda_event_source_mapping:  { color: '#ec4899', icon: '📡', label: 'λ ESM',          layer: 4 },

  // -- Storage ----------------------------------------------------------------
  s3:                           { color: '#f97316', icon: '📦', label: 'S3',             layer: 4 },
  ebs_volume:                   { color: '#6366f1', icon: '💾', label: 'EBS',            layer: 3 },
  efs:                          { color: '#14b8a6', icon: '📁', label: 'EFS',            layer: 3 },
  fsx:                          { color: '#818cf8', icon: '📂', label: 'FSx',            layer: 3 },
  datasync_task:                { color: '#64748b', icon: '🔄', label: 'DataSync',       layer: 4 },
  // new v9
  s3_bucket_policy:             { color: '#f97316', icon: '📋', label: 'S3 Policy',      layer: 5 },
  transfer_server:              { color: '#06b6d4', icon: '📤', label: 'SFTP',           layer: 4 },
  backup_vault:                 { color: '#34d399', icon: '🔒', label: 'Bkp Vault',      layer: 4 },
  storage_gateway:              { color: '#6366f1', icon: '🌉', label: 'Stor GW',        layer: 4 },

  // -- Database --------------------------------------------------------------
  rds:                          { color: '#8b5cf6', icon: '🗄️', label: 'RDS',            layer: 3 },
  dynamodb:                     { color: '#059669', icon: '🧾', label: 'DynamoDB',       layer: 3 },
  elasticache:                  { color: '#d946ef', icon: '🧠', label: 'Cache',          layer: 3 },
  aurora_cluster:               { color: '#7c3aed', icon: '🌌', label: 'Aurora',         layer: 3 },
  redshift_cluster:             { color: '#6366f1', icon: '📊', label: 'Redshift',       layer: 3 },
  opensearch_domain:            { color: '#f97316', icon: '🔍', label: 'OpenSearch',     layer: 3 },
  documentdb_cluster:           { color: '#10b981', icon: '🍃', label: 'DocumentDB',     layer: 3 },
  rds_proxy:                    { color: '#a78bfa', icon: '🔄', label: 'RDS Proxy',      layer: 3 },
  timestream_database:          { color: '#0ea5e9', icon: '⏱️', label: 'Timestream',     layer: 3 },
  // new v9
  db_subnet_group:              { color: '#8b5cf6', icon: '🔗', label: 'DB Subnet Grp',  layer: 2 },
  db_parameter_group:           { color: '#8b5cf6', icon: '⚙️', label: 'DB Params',      layer: 5 },
  dynamodb_global_table:        { color: '#059669', icon: '🌐', label: 'DDB Global',     layer: 3 },
  dax_cluster:                  { color: '#10b981', icon: '⚡', label: 'DAX',            layer: 3 },
  neptune_cluster:              { color: '#8b5cf6', icon: '🔵', label: 'Neptune',        layer: 3 },
  memorydb_cluster:             { color: '#ef4444', icon: '🔴', label: 'MemoryDB',       layer: 3 },
  keyspaces_table:              { color: '#6366f1', icon: '⬡',  label: 'Keyspaces',      layer: 3 },

  // -- IAM & Security --------------------------------------------------------
  iam_role:                     { color: '#f43f5e', icon: '🔑', label: 'IAM Role',       layer: 5 },
  iam_user:                     { color: '#f43f5e', icon: '👤', label: 'IAM User',       layer: 5 },
  iam_policy:                   { color: '#f43f5e', icon: '📜', label: 'IAM Policy',     layer: 5 },
  iam_group:                    { color: '#f43f5e', icon: '👥', label: 'IAM Group',      layer: 5 },
  kms_key:                      { color: '#fbbf24', icon: '🔐', label: 'KMS',            layer: 5 },
  kms:                          { color: '#fbbf24', icon: '🔐', label: 'KMS',            layer: 5 },
  secrets_manager:              { color: '#fb923c', icon: '🤫', label: 'Secrets',        layer: 5 },
  acm_certificate:              { color: '#34d399', icon: '📜', label: 'ACM Cert',       layer: 5 },
  security_hub:                 { color: '#ef4444', icon: '🛡️', label: 'Sec Hub',        layer: 5 },
  macie:                        { color: '#ef4444', icon: '🕵️', label: 'Macie',          layer: 5 },
  inspector2:                   { color: '#ef4444', icon: '🔎', label: 'Inspector',      layer: 5 },
  iam_oidc_provider:            { color: '#f43f5e', icon: '🔓', label: 'OIDC',           layer: 5 },
  cognito_user_pool:            { color: '#818cf8', icon: '👤', label: 'Cognito UP',     layer: 4 },
  // new v9
  iam_access_analyzer:          { color: '#f43f5e', icon: '🔍', label: 'Access Anlzr',  layer: 5 },
  shield_protection:            { color: '#ef4444', icon: '🛡️', label: 'Shield',         layer: 5 },
  fms_policy:                   { color: '#ef4444', icon: '🏛️', label: 'FMS Policy',     layer: 5 },
  ssoadmin_instance:            { color: '#818cf8', icon: '🔐', label: 'Identity Ctr',  layer: 5 },
  ram_resource_share:           { color: '#a78bfa', icon: '🤝', label: 'RAM Share',      layer: 5 },
  directory_service_directory:  { color: '#6366f1', icon: '📒', label: 'AD',             layer: 5 },
  cognito_identity_pool:        { color: '#818cf8', icon: '🆔', label: 'Identity Pool', layer: 4 },
  acmpca_certificate_authority: { color: '#34d399', icon: '🏛️', label: 'Private CA',    layer: 5 },
  verifiedaccess_instance:      { color: '#06b6d4', icon: '✅', label: 'Verified Access',layer: 5 },

  // -- Monitoring ------------------------------------------------------------
  cloudwatch_alarm:             { color: '#0284c7', icon: '🚨', label: 'CW Alarm',       layer: 5 },
  cloudwatch_log_group:         { color: '#0284c7', icon: '📋', label: 'CW Logs',        layer: 5 },
  cloudwatch:                   { color: '#0284c7', icon: '📈', label: 'CW',             layer: 5 },
  sns_topic:                    { color: '#e11d48', icon: '📣', label: 'SNS',            layer: 4 },
  sns:                          { color: '#e11d48', icon: '📣', label: 'SNS',            layer: 4 },
  sqs_queue:                    { color: '#7c3aed', icon: '📥', label: 'SQS',            layer: 4 },
  sqs:                          { color: '#7c3aed', icon: '📥', label: 'SQS',            layer: 4 },
  eventbridge_rule:             { color: '#f59e0b', icon: '⚡', label: 'EventBridge',    layer: 4 },
  cloudwatch_dashboard:         { color: '#0284c7', icon: '📊', label: 'CW Dashboard',  layer: 5 },
  xray_group:                   { color: '#818cf8', icon: '🔭', label: 'X-Ray',          layer: 5 },
  prometheus_workspace:         { color: '#e11d48', icon: '📈', label: 'Prometheus',     layer: 5 },
  grafana_workspace:            { color: '#f97316', icon: '📊', label: 'Grafana',        layer: 5 },
  // new v9
  cloudwatch_composite_alarm:   { color: '#0284c7', icon: '🔔', label: 'Comp Alarm',     layer: 5 },
  synthetics_canary:            { color: '#84cc16', icon: '🐦', label: 'Canary',         layer: 5 },
  cloudwatch_metric_stream:     { color: '#0284c7', icon: '🌊', label: 'Metric Stream',  layer: 5 },
  rum_app_monitor:              { color: '#f59e0b', icon: '👁️', label: 'RUM',            layer: 5 },
  pipes_pipe:                   { color: '#f59e0b', icon: '🔧', label: 'EB Pipes',       layer: 4 },
  scheduler_schedule:           { color: '#f59e0b', icon: '⏰', label: 'Scheduler',      layer: 4 },
  devopsguru_resource_collection:{ color: '#818cf8',icon: '🤖', label: 'DevOps Guru',    layer: 5 },
  chatbot_slack_channel_configuration:{ color:'#4a154b',icon:'💬',label:'Chatbot',        layer: 5 },

  // -- Containers ------------------------------------------------------------
  eks:                          { color: '#3b82f6', icon: '☸️', label: 'EKS',            layer: 3 },
  ecs_cluster:                  { color: '#06b6d4', icon: '🐳', label: 'ECS',            layer: 3 },
  ecr_repository:               { color: '#0ea5e9', icon: '📦', label: 'ECR',            layer: 4 },
  ecs_task_definition:          { color: '#06b6d4', icon: '📋', label: 'Task Def',       layer: 4 },
  ecs_service:                  { color: '#06b6d4', icon: '⚙️', label: 'ECS Svc',        layer: 3 },
  eks_node_group:               { color: '#3b82f6', icon: '🖥️', label: 'Node Group',     layer: 3 },
  eks_fargate_profile:          { color: '#3b82f6', icon: '🚀', label: 'Fargate',        layer: 3 },
  // new v9
  eks_addon:                    { color: '#3b82f6', icon: '🧩', label: 'EKS Addon',      layer: 4 },
  appmesh_mesh:                 { color: '#06b6d4', icon: '🕸️', label: 'App Mesh',       layer: 4 },
  ecr_lifecycle_policy:         { color: '#0ea5e9', icon: '♻️', label: 'ECR Lifecycle',  layer: 4 },
  ecs_capacity_provider:        { color: '#06b6d4', icon: '📊', label: 'ECS Cap Prov',   layer: 4 },
  eks_identity_provider_config: { color: '#3b82f6', icon: '🔓', label: 'EKS IdP',        layer: 5 },
  ecrpublic_repository:         { color: '#0ea5e9', icon: '🌐', label: 'ECR Public',     layer: 4 },

  // -- CI/CD -----------------------------------------------------------------
  codepipeline:                 { color: '#f59e0b', icon: '🚀', label: 'Pipeline',       layer: 4 },
  codebuild:                    { color: '#f59e0b', icon: '🔨', label: 'CodeBuild',      layer: 4 },
  codedeploy:                   { color: '#f59e0b', icon: '📦', label: 'CodeDeploy',     layer: 4 },
  api_gateway:                  { color: '#10b981', icon: '🔀', label: 'API GW',         layer: 4 },
  api_gateway_v2:               { color: '#10b981', icon: '⚡', label: 'HTTP API',       layer: 4 },
  codecommit:                   { color: '#f59e0b', icon: '📝', label: 'CodeCommit',     layer: 4 },
  codeartifact:                 { color: '#f59e0b', icon: '📦', label: 'Artifact',       layer: 4 },
  amplify_app:                  { color: '#f59e0b', icon: '🌐', label: 'Amplify',        layer: 4 },
  // new v9
  codestarconnections_connection:{ color:'#f59e0b', icon: '🔗', label: 'Codestar Conn', layer: 4 },
  api_gateway_domain_name:      { color: '#10b981', icon: '🌐', label: 'API Domain',     layer: 4 },
  api_gateway_stage:            { color: '#10b981', icon: '📋', label: 'API Stage',      layer: 4 },
  appconfig_application:        { color: '#f59e0b', icon: '🚩', label: 'AppConfig',      layer: 4 },
  cloud9_environment_ec2:       { color: '#f59e0b', icon: '☁️', label: 'Cloud9',         layer: 4 },
  codegurureviewer_repository_association:{ color:'#f59e0b',icon:'🤖',label:'CodeGuru',  layer: 4 },
  servicecatalog_portfolio:     { color: '#818cf8', icon: '🗂️', label: 'Svc Catalog',    layer: 4 },

  // -- Admin & Ops -----------------------------------------------------------
  ssm_parameter:                { color: '#64748b', icon: '⚙️', label: 'SSM Param',      layer: 5 },
  aws_backup:                   { color: '#34d399', icon: '💾', label: 'Backup',         layer: 4 },
  cloudtrail:                   { color: '#6366f1', icon: '🕵️', label: 'CloudTrail',     layer: 5 },
  guardduty:                    { color: '#ef4444', icon: '🛡️', label: 'GuardDuty',      layer: 5 },
  waf:                          { color: '#ef4444', icon: '🔥', label: 'WAF',            layer: 5 },
  budgets:                      { color: '#84cc16', icon: '💰', label: 'Budget',         layer: 5 },
  config_rule:                  { color: '#6366f1', icon: '📏', label: 'Config Rule',    layer: 5 },
  ssm_patch_baseline:           { color: '#64748b', icon: '🩹', label: 'Patch',          layer: 5 },
  ses_email_identity:           { color: '#06b6d4', icon: '📧', label: 'SES Identity',  layer: 4 },
  organizations_account:        { color: '#818cf8', icon: '🏢', label: 'Org Account',   layer: 5 },
  service_control_policy:       { color: '#818cf8', icon: '📜', label: 'SCP',            layer: 5 },
  config_conformance_pack:      { color: '#6366f1', icon: '📦', label: 'Conformance',   layer: 5 },
  ssm_maintenance_window:       { color: '#64748b', icon: '🔧', label: 'Maint Window',  layer: 5 },
  route53_health_check:         { color: '#b45309', icon: '❤️', label: 'Health Chk',    layer: 0 },
  // new v9
  cloudformation_stack:         { color: '#818cf8', icon: '🏗️', label: 'CFN Stack',     layer: 4 },
  resourcegroups_group:         { color: '#64748b', icon: '🗂️', label: 'Res Group',      layer: 5 },
  ce_anomaly_monitor:           { color: '#84cc16', icon: '📉', label: 'Anomaly Detect', layer: 5 },
  fis_experiment_template:      { color: '#ef4444', icon: '🧪', label: 'FIS Chaos',      layer: 5 },
  drs_replication_configuration_template:{ color:'#6366f1',icon:'🔄',label:'DRS',        layer: 4 },

  // -- Analytics -------------------------------------------------------------
  kinesis_stream:               { color: '#f97316', icon: '🌊', label: 'Kinesis',        layer: 4 },
  kinesis_firehose:             { color: '#f97316', icon: '🔥', label: 'Firehose',       layer: 4 },
  glue_job:                     { color: '#f97316', icon: '🔧', label: 'Glue Job',       layer: 4 },
  glue_catalog_database:        { color: '#f97316', icon: '📚', label: 'Glue DB',        layer: 4 },
  athena_workgroup:             { color: '#f97316', icon: '🔍', label: 'Athena',         layer: 4 },
  msk_cluster:                  { color: '#f97316', icon: '📨', label: 'MSK',            layer: 3 },
  emr_cluster:                  { color: '#f97316', icon: '⚡', label: 'EMR',            layer: 3 },
  // new v9
  glue_crawler:                 { color: '#f97316', icon: '🕷️', label: 'Glue Crawler',   layer: 4 },
  glue_workflow:                { color: '#f97316', icon: '🔗', label: 'Glue Workflow',  layer: 4 },
  lakeformation_resource:       { color: '#f97316', icon: '🏞️', label: 'Lake Formation', layer: 4 },
  quicksight_data_set:          { color: '#f97316', icon: '📊', label: 'QuickSight',     layer: 4 },
  opensearchserverless_collection:{ color:'#f97316',icon: '🔍', label: 'OSS',            layer: 3 },
  redshift_serverless_workgroup:{ color: '#6366f1', icon: '🔺', label: 'Redshift Svr',  layer: 3 },

  // -- App Integration -------------------------------------------------------
  step_functions:               { color: '#14b8a6', icon: '🔄', label: 'Step Fn',        layer: 4 },
  appsync:                      { color: '#818cf8', icon: '⚡', label: 'AppSync',        layer: 4 },
  mq_broker:                    { color: '#f97316', icon: '📨', label: 'MQ Broker',      layer: 3 },
  eventbridge_bus:              { color: '#f59e0b', icon: '🚌', label: 'Event Bus',      layer: 4 },
  // new v9
  ses_configuration_set:        { color: '#06b6d4', icon: '📧', label: 'SES Config',     layer: 4 },
  pinpoint_app:                 { color: '#ec4899', icon: '📱', label: 'Pinpoint',       layer: 4 },
  appflow_flow:                 { color: '#14b8a6', icon: '🔄', label: 'AppFlow',        layer: 4 },
  cognito_user_pool_client:     { color: '#818cf8', icon: '🔑', label: 'UP Client',      layer: 4 },
  cloudwatch_event_api_destination:{ color:'#f59e0b',icon:'🎯',label:'API Dest',         layer: 4 },
  sqs_queue_redrive_policy:     { color: '#7c3aed', icon: '☠️', label: 'DLQ',            layer: 4 },

  // -- Machine Learning ------------------------------------------------------
  sagemaker_notebook:           { color: '#ec4899', icon: '📓', label: 'SM Notebook',    layer: 3 },
  sagemaker_endpoint:           { color: '#ec4899', icon: '🤖', label: 'SM Endpoint',    layer: 3 },
  bedrock_model_invocation:     { color: '#ec4899', icon: '🧠', label: 'Bedrock',        layer: 3 },
  // new v9
  sagemaker_domain:             { color: '#ec4899', icon: '🏠', label: 'SM Domain',      layer: 3 },
  sagemaker_pipeline:           { color: '#ec4899', icon: '🔗', label: 'SM Pipeline',    layer: 4 },
  sagemaker_feature_group:      { color: '#ec4899', icon: '🗃️', label: 'Feature Store',  layer: 4 },
  rekognition_collection:       { color: '#818cf8', icon: '👁️', label: 'Rekognition',    layer: 4 },
  comprehend_entity_recognizer: { color: '#818cf8', icon: '📖', label: 'Comprehend',     layer: 4 },
  bedrock_custom_model:         { color: '#ec4899', icon: '🧬', label: 'Bedrock Custom', layer: 3 },
};
function getMeta(st) {
  return SERVICE_META[st] || { color: '#94a3b8', icon: '[*]', label: st, layer: 3 };
}

// --- Human-readable edge labels -----------------------------------------------
const EDGE_LABEL_MAP = {
  vpc_id:                              'in VPC',
  subnet_id:                           'in subnet',
  subnet_ids:                          'in subnets',
  vpc_zone_identifier:                 'in subnets',
  staging_area_subnet_id:              'staging subnet',
  vpc_security_group_ids:              'uses SG',
  security_group_ids:                  'uses SG',
  security_groups:                     'uses SG',
  replication_servers_security_groups_ids: 'uses SG',
  allocation_id:                       'uses EIP',
  nat_gateway_id:                      'via NAT',
  gateway_id:                          'via IGW',
  route_table_id:                      'in RT',
  resolver_endpoint_id:                'via resolver',
  iam_instance_profile:                'uses IAM',
  role_arn:                            'uses IAM',
  execution_role:                      'uses IAM',
  data_access_role_arn:                'uses IAM',
  service_role:                        'uses IAM',
  target_group_arns:                   'behind ALB',
  load_balancer_arn:                   'on LB',
  listener_arn:                        'on listener',
  kms_key_id:                          'encrypted by',
  kms_key_arn:                         'encrypted by',
  s3_bucket:                           'in S3',
  bucket_name:                         'in S3',
  artifact_s3_location:                'artifacts in S3',
  db_subnet_group_name:                'in subnet group',
  subnet_group_name:                   'in subnet group',
  cluster_name:                        'in cluster',
  task_definition:                     'uses task def',
  auto_scaling_group_arn:              'on ASG',
  zone_id:                             'in hosted zone',
  event_source_arn:                    'triggered by',
  source:                              'source',
  target:                              'target',
  firehose_arn:                        'to Firehose',
  sns_topic_arn:                       'alerts via SNS',
  sns_topic_arns:                      'alerts via SNS',
  user_pool_id:                        'in User Pool',
  identity_pool_id:                    'uses Identity Pool',
  ipam_scope_id:                       'in IPAM scope',
  rest_api_id:                         'on API',
  deployment_id:                       'deploys',
  connection_arn:                      'uses connection',
  base_model_identifier:               'fine-tunes',
  image_recipe_arn:                    'uses recipe',
  infrastructure_configuration_arn:    'uses infra config',
};
function edgeLabel(fieldId) {
  return EDGE_LABEL_MAP[fieldId] || fieldId.replace(/_/g, ' ');
}

// --- Subnet public/private detection -----------------------------------------
function getSubnetType(resource) {
  if (resource.service_type !== 'subnet') return null;
  const name = (resource.config?.name || resource.label || '').toLowerCase();
  const mapPublic = String(resource.config?.map_public_ip ?? '');
  if (mapPublic === 'true'  || name.includes('public'))  return 'public';
  if (mapPublic === 'false' || name.includes('private')) return 'private';
  return 'unknown';
}

// --- Derive all edges (wiredFrom + config reference scanning) -----------------
function deriveEdges(resources) {
  const edges = [];
  const seen  = new Set();
  const addEdge = (fromId, toId, fieldId) => {
    const key = `${fromId}→'${toId}:${fieldId}`;
    if (seen.has(key) || fromId === toId) return;
    seen.add(key);
    edges.push({ fromId, toId, fieldId, label: edgeLabel(fieldId) });
  };

  // 1. wiredFrom-based edges (the existing mechanism)
  for (const r of resources) {
    if (!r.wiredFrom) continue;
    for (const [fieldId, wire] of Object.entries(r.wiredFrom)) {
      const ids = Array.isArray(wire.sourceId) ? wire.sourceId : [wire.sourceId];
      for (const sid of ids) {
        if (resources.find(x => x._id === sid)) addEdge(sid, r._id, fieldId);
      }
    }
  }

  // 2. Config reference inference - scan "aws_type.name.attr" Terraform refs
  //    Build a lookup: resource_name →' _id
  const nameToId = {};
  for (const r of resources) {
    const n = r.config?.name;
    if (n) {
      nameToId[n] = r._id;
      nameToId[n.replace(/[^a-z0-9_]/gi, '_')] = r._id;
    }
  }
  for (const r of resources) {
    if (!r.config) continue;
    for (const [fieldId, rawVal] of Object.entries(r.config)) {
      const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
      for (const v of vals) {
        if (!v || typeof v !== 'string') continue;
        for (const m of v.matchAll(/aws_\w+\.(\w+)\.\w+/g)) {
          const providerId = nameToId[m[1]];
          if (providerId && providerId !== r._id) addEdge(providerId, r._id, fieldId);
        }
      }
    }
  }

  return edges;
}

// --- Compute which resources belong inside each VPC ---------------------------
function computeVpcMembers(resources, edges) {
  const result = {};
  for (const vpc of resources.filter(r => r.service_type === 'vpc')) {
    const members = new Set();
    const queue   = [vpc._id];
    const visited = new Set([vpc._id]);
    while (queue.length) {
      const cur = queue.shift();
      for (const e of edges) {
        // Only follow edges that originate FROM the current node (dependency →' consumer)
        if (e.fromId === cur && !visited.has(e.toId)) {
          visited.add(e.toId);
          const child = resources.find(x => x._id === e.toId);
          if (child && child.service_type !== 'vpc') {
            members.add(e.toId);
            queue.push(e.toId);
          }
        }
      }
    }
    if (members.size > 0) result[vpc._id] = members;
  }
  return result;
}

// --- Architecture validation warnings ----------------------------------------
function computeWarnings(resources, edges) {
  const warnings = {};
  const push = (id, msg) => { if (!warnings[id]) warnings[id] = []; warnings[id].push(msg); };

  const hasNat = resources.some(r => r.service_type === 'nat_gateway');
  const hasIgw = resources.some(r => r.service_type === 'internet_gateway' || r.service_type === 'igw');
  const hasRt  = resources.some(r => r.service_type === 'route_table');

  for (const r of resources) {
    if (r.service_type === 'ec2') {
      const subnetEdge = edges.find(e =>
        e.toId === r._id && resources.find(x => x._id === e.fromId)?.service_type === 'subnet'
      );
      if (subnetEdge) {
        const subnet = resources.find(x => x._id === subnetEdge.fromId);
        if (getSubnetType(subnet) === 'private' && !hasNat) {
          push(r._id, 'EC2 in private subnet without NAT Gateway');
        }
      }
    }

    if (r.service_type === 'subnet') {
      // Subnet not associated with a route table (when RT exists)
      if (hasRt) {
        const connected = edges.some(e =>
          (e.fromId === r._id || e.toId === r._id) &&
          resources.find(x => x._id === (e.fromId === r._id ? e.toId : e.fromId))?.service_type === 'route_table'
        );
        if (!connected) push(r._id, 'No Route Table associated');
      }
    }

    if (r.service_type === 'internet_gateway' || r.service_type === 'igw') {
      const connectedVpc = edges.some(e =>
        (e.fromId === r._id || e.toId === r._id) &&
        resources.find(x => x._id === (e.fromId === r._id ? e.toId : e.fromId))?.service_type === 'vpc'
      );
      if (!connectedVpc && resources.some(x => x.service_type === 'vpc')) {
        push(r._id, 'IGW not attached to VPC');
      }
    }
  }
  return warnings;
}

// --- AWS-aware smart layout ---------------------------------------------------
const NODE_W = 148;
const NODE_H = 72;

function smartLayout(resources) {
  const COL_GAP = NODE_W + 84;
  const ROW_GAP = NODE_H + 54;
  const PAD     = 44;

  // Group by semantic layer
  const byLayer = {};
  for (const r of resources) {
    const l = getMeta(r.service_type).layer ?? 3;
    (byLayer[l] = byLayer[l] || []).push(r);
  }

  const sortedLayers = Object.keys(byLayer).map(Number).sort((a, b) => a - b);
  const pos = {};

  sortedLayers.forEach((layer, colIdx) => {
    const items = byLayer[layer];
    // Sort subnets: public before private
    items.sort((a, b) => {
      if (a.service_type === 'subnet' && b.service_type === 'subnet') {
        const ta = getSubnetType(a), tb = getSubnetType(b);
        if (ta === 'public' && tb !== 'public') return -1;
        if (ta !== 'public' && tb === 'public') return  1;
      }
      return 0;
    });
    items.forEach((r, rowIdx) => {
      pos[r._id] = { x: PAD + colIdx * COL_GAP, y: PAD + rowIdx * ROW_GAP };
    });
  });
  return pos;
}

// --- Cost table ---------------------------------------------------------------
const NODE_COSTS = {
  ec2:'~$30/mo', rds:'~$50/mo', alb:'~$16/mo', nat_gateway:'~$32/mo',
  eks:'~$73/mo', elasticache:'~$26/mo', eip:'~$4/mo',
  vpc:'Free', subnet:'Free', security_group:'Free', internet_gateway:'Free',
  route_table:'Free', iam_role:'Free',
  s3:'Usage', lambda:'Usage', dynamodb:'Usage', sns:'Usage', sqs:'Usage',
};
function getCostLabel(serviceType, config = {}) {
  if (serviceType === 'ec2' && config.instance_type) {
    const T = {'t3.micro':7.59,'t3.small':15.18,'t3.medium':30.37,'t3.large':60.74,'m5.large':70.08,'m5.xlarge':140.16};
    const c = T[config.instance_type];
    if (c !== undefined) return c === 0 ? 'Free' : `~$${c}/mo`;
  }
  return NODE_COSTS[serviceType] || null;
}

// --- SVG cubic-bezier edge ----------------------------------------------------
function EdgePath({ x1, y1, x2, y2, color = '#94a3b8', label, onDelete }) {
  const markerId = `arr-${color.replace('#', '')}`;
  const dx  = x2 - x1;
  const cx1 = x1 + Math.max(36, dx * 0.42);
  const cx2 = x2 - Math.max(36, dx * 0.42);
  const d   = `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
  const lx  = (x1 + x2) / 2;
  const ly  = (y1 + y2) / 2 - 9;
  const charW = 5.2;
  const labelW = label ? label.length * charW + 8 : 0;

  return (
    <g>
      <defs>
        <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,1 L0,6 L7,3.5 z" fill={color} opacity={0.75} />
        </marker>
      </defs>
      {/* Wide invisible click zone */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={16}
        style={{ cursor: 'pointer' }} onClick={onDelete} />
      {/* Visible edge */}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6}
        markerEnd={`url(#${markerId})`} />
      {/* Edge label pill */}
      {label && (
        <g>
          <rect x={lx - labelW / 2} y={ly - 8} width={labelW} height={13}
            rx={3} fill="#0f172a" stroke={color} strokeWidth={0.6} opacity={0.88} />
          <text x={lx} y={ly + 1} textAnchor="middle" fontSize={8}
            fill={color} opacity={0.9}
            style={{ pointerEvents: 'none', userSelect: 'none', fontFamily: 'JetBrains Mono, monospace' }}>
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

// --- VPC group container rect -------------------------------------------------
function VpcGroupRect({ vpcResource, memberIds, positions }) {
  if (!memberIds || memberIds.size === 0) return null;
  const allIds = [vpcResource._id, ...memberIds];
  const pts    = allIds.map(id => positions[id]).filter(Boolean);
  if (pts.length === 0) return null;

  const PAD  = 20;
  const minX = Math.min(...pts.map(p => p.x))         - PAD;
  const minY = Math.min(...pts.map(p => p.y))         - PAD - 16; // extra top for label
  const maxX = Math.max(...pts.map(p => p.x + NODE_W)) + PAD;
  const maxY = Math.max(...pts.map(p => p.y + NODE_H)) + PAD;
  const meta = getMeta('vpc');
  const vpcName = vpcResource.config?.name || vpcResource.label || 'VPC';

  return (
    <g>
      {/* Outer glow */}
      <rect x={minX - 3} y={minY - 3} width={maxX - minX + 6} height={maxY - minY + 6}
        rx={15} fill="none" stroke={meta.color} strokeWidth={1} opacity={0.12} />
      {/* Container */}
      <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY}
        rx={12} fill={meta.color} fillOpacity={0.05}
        stroke={meta.color} strokeWidth={1.2} strokeDasharray="7 4" opacity={0.5} />
      {/* VPC label */}
      <text x={minX + 10} y={minY + 13} fontSize={9} fill={meta.color} opacity={0.75}
        fontWeight={700} fontFamily="JetBrains Mono, monospace"
        style={{ pointerEvents: 'none', userSelect: 'none' }}>
        VPC: {vpcName}
      </text>
    </g>
  );
}

// --- Node card ----------------------------------------------------------------
function NodeCard({ resource, x, y, selected, connecting, hasWarning,
                    onMouseDown, onClick, onMouseEnter, onMouseLeave, onConnectStart }) {
  const meta       = getMeta(resource.service_type);
  const name       = resource.config?.name || resource.label || resource.service_type;
  const costLabel  = getCostLabel(resource.service_type, resource.config || {});
  const hasCost    = costLabel !== null;
  const isFree     = costLabel === 'Free' || costLabel === 'Usage';
  const costColor  = isFree ? '#64748b' : '#00D4A1';
  const subnetType = getSubnetType(resource);
  // Public = green accent, Private = amber accent
  const subnetAccent = subnetType === 'public' ? '#22c55e' : subnetType === 'private' ? '#f59e0b' : null;

  const borderColor = connecting ? '#facc15' : selected ? '#60a5fa' : subnetAccent || meta.color;
  const borderW     = selected || connecting ? 2.5 : 1.5;

  return (
    <g transform={`translate(${x},${y})`} style={{ cursor: 'grab' }}
      onMouseDown={onMouseDown} onClick={onClick}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {/* Drop shadow */}
      <rect x={2} y={4} width={NODE_W} height={NODE_H} rx={10} fill="rgba(0,0,0,0.32)" />
      {/* Card body */}
      <rect x={0} y={0} width={NODE_W} height={NODE_H} rx={10}
        fill={selected ? '#1a2d4f' : '#111827'}
        stroke={borderColor} strokeWidth={borderW} />
      {/* Top colour stripe */}
      <rect x={0} y={0} width={NODE_W} height={4} rx={10} fill={meta.color} opacity={0.9} />
      <rect x={0} y={4} width={NODE_W} height={2} fill={meta.color} opacity={0.9} />

      {/* Subnet public/private badge */}
      {subnetAccent && (
        <g>
          <rect x={NODE_W - 48} y={6} width={42} height={13} rx={4}
            fill={subnetAccent + '22'} stroke={subnetAccent} strokeWidth={0.8} />
          <text x={NODE_W - 27} y={15} fontSize={7.5} fill={subnetAccent}
            textAnchor="middle" fontWeight={700}
            style={{ pointerEvents: 'none', userSelect: 'none' }}>
            {subnetType === 'public' ? '\u{1F310} PUBLIC' : '\u{1F512} PRIVATE'}
          </text>
        </g>
      )}

      {/* Icon circle - BUG FIX: Added white backing circle for better emoji color
          rendering in SVG across browsers. Emoji font stack ensures cross-platform
          support (Segoe UI Emoji on Windows, Apple Color Emoji on macOS/iOS,
          Noto Color Emoji on Android/Linux). */}
      <circle cx={21} cy={28} r={14} fill="#FFFFFF" opacity={0.08} />
      <circle cx={21} cy={28} r={13} fill={meta.color + '22'} />
      <text x={21} y={33} fontSize={16} textAnchor="middle"
        style={{ pointerEvents: 'none', userSelect: 'none',
          fontFamily: "Noto Color Emoji, Segoe UI Emoji, Apple Color Emoji, 'Segoe UI Symbol', 'Twemoji Mozilla', EmojiOne Color, Android Emoji, sans-serif" }}>
        {meta.icon}
      </text>

      {/* Service label */}
      <text x={40} y={22} fontSize={10} fill="#cbd5e1" fontWeight={700}
        style={{ pointerEvents: 'none', userSelect: 'none' }}>
        {meta.label}
      </text>
      {/* Resource name (truncated) */}
      <text x={40} y={34} fontSize={9} fill="#64748b"
        style={{ pointerEvents: 'none', userSelect: 'none' }}>
        {name.length > 13 ? name.slice(0, 12) + '...' : name}
      </text>

      {/* Cost badge */}
      {hasCost && (
        <g>
          <rect x={6} y={NODE_H - 20} width={NODE_W - 12} height={14} rx={4}
            fill={isFree ? '#1e293b' : '#00220d'} stroke={isFree ? '#334155' : '#00D4A1'} strokeWidth={0.8} />
            <text x={NODE_W / 2} y={NODE_H - 11} fontSize={8.5} fill={costColor}
              fontWeight={700} textAnchor="middle" dominantBaseline="middle"
              style={{ pointerEvents: 'none', userSelect: 'none', fontFamily: "Noto Color Emoji, Segoe UI Emoji, Apple Color Emoji, 'Segoe UI Symbol', 'Twemoji Mozilla', EmojiOne Color, Android Emoji, sans-serif" }}>
              💰 {costLabel}
            </text>
        </g>
      )}

      {/* Validation warning badge */}
      {hasWarning && (
        <g>
          <circle cx={NODE_W - 10} cy={10} r={8.5} fill="#ef4444" stroke="#0f172a" strokeWidth={1.5} />
          <text x={NODE_W - 10} y={11} fontSize={11} textAnchor="middle" dominantBaseline="middle"
            style={{ pointerEvents: 'none', userSelect: 'none' }}>⚠</text>
        </g>
      )}

      {/* Connect port (right edge) */}
      <circle cx={NODE_W - 2} cy={NODE_H / 2} r={5}
        fill={meta.color} stroke="#111827" strokeWidth={1.5}
        style={{ cursor: 'crosshair' }}
        onMouseDown={e => { e.stopPropagation(); onConnectStart(e); }}
      />
    </g>
  );
}

// --- Hover tooltip ------------------------------------------------------------
function NodeTooltip({ resource, x, y, warnings, svgW }) {
  if (!resource) return null;
  const meta       = getMeta(resource.service_type);
  const subnetType = getSubnetType(resource);
  const config     = resource.config || {};
  const entries    = Object.entries(config)
    .filter(([k, v]) => v && typeof v === 'string' && k !== '_lifecycle' && !k.endsWith('_multi'))
    .slice(0, 7);
  const warns  = warnings?.[resource._id] || [];
  const height = entries.length * 14 + (warns.length ? warns.length * 14 + 10 : 0) + 48;
  const width  = 210;

  // Clamp so tooltip stays inside viewport
  const TX = Math.min(x + NODE_W + 10, svgW - width - 6);
  const TY = Math.max(y - 8, 6);

  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* Shadow */}
      <rect x={TX + 2} y={TY + 4} width={width} height={height} rx={9}
        fill="rgba(0,0,0,0.5)" />
      {/* Body */}
      <rect x={TX} y={TY} width={width} height={height} rx={8}
        fill="#1e293b" stroke={meta.color} strokeWidth={1.2} />
      {/* Header */}
      <text x={TX + 10} y={TY + 15} fontSize={11} fill={meta.color} fontWeight={700}
        style={{ userSelect: 'none', fontFamily: "Noto Color Emoji, Segoe UI Emoji, Apple Color Emoji, 'Segoe UI Symbol', 'Twemoji Mozilla', EmojiOne Color, Android Emoji, sans-serif" }}>
        {meta.icon} {meta.label}{subnetType ? ` · ${subnetType}` : ''}
      </text>
      <text x={TX + 10} y={TY + 27} fontSize={9} fill="#94a3b8" style={{ userSelect: 'none' }}>
        {resource.config?.name || resource.label || '-'}
      </text>
      <line x1={TX + 6} y1={TY + 33} x2={TX + width - 6} y2={TY + 33}
        stroke="#334155" strokeWidth={0.8} />

      {/* Config entries */}
      {entries.map(([k, v], i) => {
        const display = String(v);
        return (
          <g key={k}>
            <text x={TX + 10} y={TY + 45 + i * 14} fontSize={8.5}
              fill="#64748b" style={{ userSelect: 'none' }}>
              {k.length > 16 ? k.slice(0, 15) + '...' : k}:
            </text>
            <text x={TX + 110} y={TY + 45 + i * 14} fontSize={8.5}
              fill="#cbd5e1" style={{ userSelect: 'none' }}>
              {display.length > 15 ? display.slice(0, 14) + '...' : display}
            </text>
          </g>
        );
      })}

      {/* Warnings */}
      {warns.length > 0 && (
        <g>
          <line x1={TX + 6} y1={TY + 43 + entries.length * 14}
            x2={TX + width - 6} y2={TY + 43 + entries.length * 14}
            stroke="#ef4444" strokeWidth={0.5} opacity={0.6} />
          {warns.map((w, i) => (
            <text key={i} x={TX + 10} y={TY + 56 + entries.length * 14 + i * 14}
              fontSize={8} fill="#fca5a5" style={{ userSelect: 'none' }}>
              ⚠ {w.length > 30 ? w.slice(0, 29) + '...' : w}
            </text>
          ))}
        </g>
      )}
    </g>
  );
}

// --- ResourceGraph ------------------------------------------------------------
/**
 * Props:
 *   resources   - array of resource objects
 *   onChange    - (resources) => void  (positions / wiring changes)
 *   onSelect    - (resourceIndex) => void
 *   environment - string
 */
export default function ResourceGraph({ resources, onChange, onSelect, environment = 'dev' }) {
  const svgRef = useRef(null);

  // -- Positions (fall back to grid) ------------------------------------------
  const initPositions = useCallback(() => {
    const pos = {};
    resources.forEach((r, i) => {
      pos[r._id] = {
        x: r.position_x ?? (80 + (i % 4) * (NODE_W + 48)),
        y: r.position_y ?? (60 + Math.floor(i / 4) * (NODE_H + 56)),
      };
    });
    return pos;
  }, []); // eslint-disable-line

  const [positions, setPositions]   = useState(initPositions);
  const [selected,  setSelected]    = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [connectLine, setConnectLine] = useState(null);
  const [hoverNode,   setHoverNode]   = useState(null);

  // Add positions for newly added resources
  useEffect(() => {
    setPositions(prev => {
      const next = { ...prev };
      resources.forEach((r, i) => {
        if (!next[r._id]) {
          next[r._id] = {
            x: 80 + (i % 4) * (NODE_W + 48),
            y: 60 + Math.floor(i / 4) * (NODE_H + 56),
          };
        }
      });
      return next;
    });
  }, [resources]);

  // -- Derived data ------------------------------------------------------------
  const edges      = useMemo(() => deriveEdges(resources),               [resources]);
  const vpcMembers = useMemo(() => computeVpcMembers(resources, edges),  [resources, edges]);
  const warnings   = useMemo(() => computeWarnings(resources, edges),    [resources, edges]);
  const warnCount  = Object.keys(warnings).length;

  // -- Drag logic --------------------------------------------------------------
  const dragging  = useRef(null);
  const dragMoved = useRef(false);

  function onNodeMouseDown(e, id) {
    if (connectFrom) return;
    e.preventDefault();
    const svg  = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const sx   = svg.viewBox.baseVal.width  / rect.width;
    const sy   = svg.viewBox.baseVal.height / rect.height;
    dragging.current = {
      id,
      startX: e.clientX * sx, startY: e.clientY * sy,
      origX:  positions[id]?.x ?? 0,
      origY:  positions[id]?.y ?? 0,
    };
    dragMoved.current = false;
  }

  useEffect(() => {
    function onMouseMove(e) {
      const svg  = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const sx   = svg.viewBox.baseVal.width  / rect.width;
      const sy   = svg.viewBox.baseVal.height / rect.height;

      if (connectFrom) {
        setConnectLine({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy });
        return;
      }
      if (!dragging.current) return;
      const dx = e.clientX * sx - dragging.current.startX;
      const dy = e.clientY * sy - dragging.current.startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragMoved.current = true;
      setPositions(prev => ({
        ...prev,
        [dragging.current.id]: {
          x: Math.max(0, dragging.current.origX + dx),
          y: Math.max(0, dragging.current.origY + dy),
        },
      }));
    }

    function onMouseUp() {
      const moved = dragMoved.current;
      dragging.current  = null;
      dragMoved.current = false;
      if (moved && onChange) {
        // Persist new positions - read latest from setter form
        setPositions(cur => {
          onChange(resources.map(r => ({
            ...r,
            position_x: cur[r._id]?.x ?? r.position_x,
            position_y: cur[r._id]?.y ?? r.position_y,
          })));
          return cur;
        });
      }
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  }, [connectFrom, resources, onChange]);

  // -- Connect mode -------------------------------------------------------------
  function startConnect(e, fromId) {
    e.preventDefault();
    setConnectFrom(fromId);
    const svg  = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const sx   = svg.viewBox.baseVal.width  / rect.width;
    const sy   = svg.viewBox.baseVal.height / rect.height;
    setConnectLine({ x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy });
  }

  function finishConnect(toId) {
    if (!connectFrom || connectFrom === toId) { setConnectFrom(null); setConnectLine(null); return; }
    const fromRes = resources.find(r => r._id === connectFrom);
    const toRes   = resources.find(r => r._id === toId);
    const fieldId = guessFieldId(fromRes?.service_type, toRes?.schema_def);
    if (fieldId) onChange?.(connectByEdge(resources, connectFrom, toId, fieldId, environment));
    setConnectFrom(null);
    setConnectLine(null);
  }

  function guessFieldId(fromType, targetSchema) {
    if (!targetSchema) return null;
    const MAP = {
      vpc:              ['vpc_id'],
      subnet:           ['subnet_id', 'subnet_ids', 'db_subnet_group_name'],
      security_group:   ['security_group_ids', 'vpc_security_group_ids', 'security_groups'],
      internet_gateway: ['gateway_id'],
      igw:              ['gateway_id'],
      nat_gateway:      ['nat_gateway_id'],
      route_table:      ['route_table_id'],
      kms:              ['kms_key_id'],
      iam_role:         ['iam_instance_profile', 'role_arn'],
      alb:              ['target_group_arns'],
    };
    const wanted = MAP[fromType] || [];
    for (const w of wanted) if (targetSchema.find(f => f.id === w)) return w;
    return targetSchema.find(f =>
      f.id.endsWith('_id') || f.id.endsWith('_ids') || f.id.endsWith('_arn')
    )?.id || null;
  }

  function handleDeleteEdge(fromId, toId, fieldId) {
    onChange?.(disconnectEdge(resources, fromId, toId, fieldId, environment));
  }

  function autoLayout() { setPositions(smartLayout(resources)); }

  // -- Viewport -----------------------------------------------------------------
  // -- Dynamic Viewport --------------------------------------------------------
  // BUG FIX: Fixed 880×530 viewBox caused nodes placed by smart-layout (or DB-
  // stored positions) to be clipped/hidden when resources exceeded the canvas.
  // We now derive a viewBox that always encloses every node with padding.
  const BASE_VW = 880, BASE_VH = 530;
  const { vbX, vbY, vbW, vbH } = useMemo(() => {
    const pts = Object.values(positions);
    if (pts.length === 0) return { vbX: 0, vbY: 0, vbW: BASE_VW, vbH: BASE_VH };
    const VPAD = 44;
    const minX = Math.min(...pts.map(p => p.x)) - VPAD;
    const minY = Math.min(...pts.map(p => p.y)) - VPAD;
    const maxX = Math.max(...pts.map(p => p.x + NODE_W)) + VPAD;
    const maxY = Math.max(...pts.map(p => p.y + NODE_H)) + VPAD;
    return {
      vbX: Math.min(0, minX),
      vbY: Math.min(0, minY),
      vbW: Math.max(BASE_VW, maxX - Math.min(0, minX)),
      vbH: Math.max(BASE_VH, maxY - Math.min(0, minY)),
    };
  }, [positions]);
  const fromPos    = connectFrom ? positions[connectFrom] : null;
  const fromCenter = fromPos
    ? { x: fromPos.x + NODE_W - 2, y: fromPos.y + NODE_H / 2 }
    : null;
  const hoveredResource = hoverNode ? resources.find(r => r._id === hoverNode) : null;
  const hoveredPos      = hoverNode ? positions[hoverNode] : null;

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-lg overflow-hidden"
      style={{ position: 'relative' }}>

      {/* -- Toolbar ------------------------------------------------------------ */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700 flex-shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-slate-300">Resource Topology</span>
        <span className="text-[10px] text-slate-500">
          {resources.length} node{resources.length !== 1 ? 's' : ''} · {edges.length} edge{edges.length !== 1 ? 's' : ''}
        </span>

        {warnCount > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/50 text-red-400 border border-red-700/40">
            ⚠ {warnCount} architecture {warnCount === 1 ? 'issue' : 'issues'}
          </span>
        )}

        <button onClick={autoLayout}
          className="ml-auto text-[11px] px-2.5 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-indigo-700 hover:text-white transition-colors"
          title="Arrange nodes in AWS semantic layers (internet →' VPC →' subnets →' compute →' services →' security)">
          ⬡ Smart Layout
        </button>

        {connectFrom && (
          <button onClick={() => { setConnectFrom(null); setConnectLine(null); }}
            className="text-[11px] px-2 py-0.5 rounded bg-yellow-600 text-white hover:bg-yellow-700">
            × Cancel Wire
          </button>
        )}

        <span className="text-[10px] text-slate-600">
          Drag to reposition · click ● to wire · click edge to remove
        </span>
      </div>

      {/* -- SVG canvas --------------------------------------------------------- */}
      <svg ref={svgRef} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className="flex-1 w-full"
        style={{ background: '#0f172a', cursor: connectFrom ? 'crosshair' : 'default' }}
        onClick={() => { if (connectFrom) { setConnectFrom(null); setConnectLine(null); } }}>

        {/* Dot grid */}
        <defs>
          <pattern id="rg-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="12" cy="12" r="0.8" fill="#1e293b" />
          </pattern>
        </defs>
        <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="url(#rg-grid)" />

        {/* VPC group containers (drawn first, behind nodes) */}
        {resources
          .filter(r => r.service_type === 'vpc')
          .map(vpc => (
            <VpcGroupRect
              key={`grp-${vpc._id}`}
              vpcResource={vpc}
              memberIds={vpcMembers[vpc._id]}
              positions={positions}
            />
          ))}

        {/* Edges */}
        {edges.map((e, i) => {
          const fp = positions[e.fromId];
          const tp = positions[e.toId];
          if (!fp || !tp) return null;
          const fromRes = resources.find(r => r._id === e.fromId);
          const meta    = getMeta(fromRes?.service_type);
          return (
            <EdgePath key={i}
              x1={fp.x + NODE_W - 2} y1={fp.y + NODE_H / 2}
              x2={tp.x}              y2={tp.y + NODE_H / 2}
              color={meta.color}
              label={e.label}
              onDelete={() => handleDeleteEdge(e.fromId, e.toId, e.fieldId)}
            />
          );
        })}

        {/* Live connect-preview line */}
        {connectFrom && fromCenter && connectLine && (
          <line x1={fromCenter.x} y1={fromCenter.y}
            x2={connectLine.x} y2={connectLine.y}
            stroke="#facc15" strokeWidth={1.5} strokeDasharray="6 3" />
        )}

        {/* Node cards */}
        {resources.map((r, i) => {
          const pos = positions[r._id] || { x: 0, y: 0 };
          return (
            <NodeCard key={r._id} resource={r}
              x={pos.x} y={pos.y}
              selected={selected === r._id}
              connecting={!!(connectFrom && hoverNode === r._id)}
              hasWarning={!!warnings[r._id]}
              onMouseDown={e => onNodeMouseDown(e, r._id)}
              onClick={() => {
                if (connectFrom && connectFrom !== r._id) finishConnect(r._id);
                else { setSelected(r._id); onSelect?.(i); }
              }}
              onMouseEnter={() => setHoverNode(r._id)}
              onMouseLeave={() => setHoverNode(null)}
              onConnectStart={e => startConnect(e, r._id)}
            />
          );
        })}

        {/* Hover tooltip (drawn on top of everything) */}
        {hoveredResource && hoveredPos && (
          <NodeTooltip
            resource={hoveredResource}
            x={hoveredPos.x} y={hoveredPos.y}
            warnings={warnings}
            svgW={vbW}
          />
        )}
      </svg>

      {/* Empty state */}
      {resources.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{ textAlign: 'center', color: '#475569' }}>
            {/* FEATURE: Emoji enhanced empty state */}
            <div style={{ fontSize: 42, marginBottom: 10, lineHeight: 1 }}>🏗️</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
              No resources yet
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', maxWidth: 260, textAlign: 'center' }}>
              🖱️ Add resources from the left panel to visualise your AWS architecture
            </div>
          </div>
        </div>
      )}

      {/* -- Legend ------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 bg-slate-800 border-t border-slate-700 text-[10px] text-slate-400 flex-shrink-0">
        <span className="flex items-center gap-1">
          <span className="legend-emoji" style={{ fontSize: 11 }}>🌐</span> Public subnet
        </span>
        <span className="flex items-center gap-1">
          <span className="legend-emoji" style={{ fontSize: 11 }}>🔒</span> Private subnet
        </span>
        <span className="flex items-center gap-1">
          <span className="legend-emoji" style={{ fontSize: 11 }}>⚠️</span> Arch issue
        </span>
        <span className="text-slate-700">|</span>
        {['vpc','subnet','ec2','rds','alb','nat_gateway','internet_gateway','security_group'].map(t => {
          const m = getMeta(t);
          return (
            <span key={t} className="flex items-center gap-1">
              <span style={{ color: m.color }}>{m.icon}</span> {m.label}
            </span>
          );
        })}
        <span className="ml-auto text-slate-600">Click edge to disconnect</span>
      </div>
    </div>
  );
}

