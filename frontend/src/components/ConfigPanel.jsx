import React, { useState, useEffect, useRef } from 'react';
import { generateHCL } from '../engine/templateEngine';
import { awsAPI } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import MultiResourcePanel from './MultiResourcePanel';

// --- Stateful resource types that benefit from lifecycle.prevent_destroy ------
const STATEFUL_TYPES = new Set([
  'rds', 'aurora_cluster', 'db_instance', 'db_cluster',
  's3', 's3_bucket',
  'dynamodb', 'dynamodb_table',
  'elasticache_cluster', 'elasticache_replication_group', 'memorydb_cluster',
  'efs_file_system', 'fsx_lustre_file_system',
  'opensearch_domain', 'elasticsearch_domain',
  'redshift_cluster',
  'secretsmanager_secret',
]);

// --- Module Help Content per service -----------------------------------------
const MODULE_HELP = {
  default: {
    registry: 'https://registry.terraform.io/browse/modules?provider=aws',
    what: 'Terraform modules are reusable, pre-tested infrastructure packages from the official registry.',
    how: ['Toggle "Use as Module" ON to switch to the module-based template.', 'Run terraform init to download the module.', 'Module inputs map 1-to-1 with the fields in this panel.'],
    tip: 'Modules handle edge cases like IAM permissions, security groups, and tagging automatically.',
  },
  vpc: { source: 'terraform-aws-modules/vpc/aws', version: '~> 5.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest', what: 'Creates a full VPC with public/private subnets, NAT gateways, and route tables in one call.', how: ['azs — list of AZs (e.g. ["ap-south-1a","ap-south-1b"]).', 'private_subnets / public_subnets — CIDR blocks.', 'enable_nat_gateway — NAT GW for private outbound.', 'single_nat_gateway — one shared NAT for dev (saves cost).'], tip: 'In prod use single_nat_gateway=false for HA. In dev/test use true to save ~$32/month per AZ.' },
  ec2: { source: 'terraform-aws-modules/ec2-instance/aws', version: '~> 5.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/ec2-instance/aws/latest', what: 'Creates an EC2 instance with encrypted root volume and IMDSv2 enforced.', how: ['ami — use the AMI picker to find region-specific IDs.', 'instance_type — t3.micro is free-tier; t3.medium+ for real workloads.', 'subnet_id — use your VPC module output: module.vpc.private_subnets[0].'], tip: 'Always launch in private subnets behind an ALB. Only ALB/bastion should have a public IP.' },
  alb: { source: 'terraform-aws-modules/alb/aws', version: '~> 9.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/alb/aws/latest', what: 'Creates an ALB with listeners, target groups, and security groups. Supports HTTP→HTTPS redirect.', how: ['subnets — MUST be public subnets for internet-facing ALBs.', 'vpc_id — reference module.vpc.vpc_id.', 'Add HTTPS listener with ACM cert for production.'], tip: 'Always redirect HTTP → HTTPS in production using aws_lb_listener.' },
  rds: { source: 'terraform-aws-modules/rds/aws', version: '~> 6.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/rds/aws/latest', what: 'Creates an RDS instance with subnet groups, parameter groups, and CloudWatch alarms.', how: ['Place DB in private subnets — module.vpc.private_subnets.', 'Set multi_az=true in production for automatic failover.', 'Use db_password via Secrets Manager.'], tip: 'Enable storage_encrypted=true and deletion_protection=true for production.' },
  eks: { source: 'terraform-aws-modules/eks/aws', version: '~> 20.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest', what: 'Creates EKS control plane, OIDC provider, managed node groups, and core add-ons.', how: ['subnet_ids — private for nodes, public for LBs.', 'eks_managed_node_groups — define multiple groups.', 'cluster_endpoint_public_access=false for production.'], tip: 'Use SPOT+ON_DEMAND mix with Karpenter for 60-80% cost savings.' },
  s3: { source: 'terraform-aws-modules/s3-bucket/aws', version: '~> 4.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/s3-bucket/aws/latest', what: 'Creates an S3 bucket with versioning, encryption, lifecycle rules, and access block.', how: ['Enable versioning for all data buckets.', 'block_public_acls=true is the secure default.', 'Use lifecycle rules to transition to Glacier.'], tip: 'Enable S3 Access Logging for audit trails. Use Intelligent-Tiering for variable access patterns.' },
  lambda: { source: 'terraform-aws-modules/lambda/aws', version: '~> 7.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest', what: 'Creates Lambda with IAM role, CloudWatch log group, optional VPC config, and Dead Letter Queue.', how: ['Package code as zip and upload to S3 or use create_package=true.', 'Set timeout to worst-case execution time (max 900s).', 'Use environment variables for config; Secrets Manager for secrets.'], tip: 'Keep packages small — cold start scales with package size. Use Lambda Layers for shared deps.' },
  // v9 modules
  kms:               { source: 'terraform-aws-modules/kms/aws',              version: '~> 3.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/kms/aws/latest',          what: 'Creates KMS keys with automatic key rotation, aliases, and granular grants.',                                        how: ['Set enable_key_rotation=true — required for SOC-2/PCI compliance.', 'Use key_policy to restrict who can administer vs use the key.', 'Create separate keys per service (S3, RDS, EKS).'],       tip: 'Set deletion_window_in_days=30 — there is no undo once a CMK is deleted.' },
  kms_key:           { source: 'terraform-aws-modules/kms/aws',              version: '~> 3.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/kms/aws/latest',          what: 'Creates KMS keys with automatic key rotation, aliases, and granular grants.',                                        how: ['Set enable_key_rotation=true — required for SOC-2/PCI compliance.', 'Use key_policy to restrict who can administer vs use the key.', 'Create separate keys per service (S3, RDS, EKS).'],       tip: 'Set deletion_window_in_days=30 — there is no undo once a CMK is deleted.' },
  acm:               { source: 'terraform-aws-modules/acm/aws',              version: '~> 4.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/acm/aws/latest',          what: 'Creates and validates ACM certificates via DNS validation using Route 53.',                                           how: ['dns validation is recommended — email validation requires manual action.', 'The certificate must be in us-east-1 for CloudFront.', 'Use wait_for_certificate=true to block until validated.'],  tip: 'DNS validation certs auto-renew silently; email certs require manual renewal every 13 months.' },
  acm_certificate:   { source: 'terraform-aws-modules/acm/aws',              version: '~> 4.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/acm/aws/latest',          what: 'Creates and validates ACM certificates via DNS validation using Route 53.',                                           how: ['dns validation is recommended — email validation requires manual action.', 'The certificate must be in us-east-1 for CloudFront.', 'Use wait_for_certificate=true to block until validated.'],  tip: 'DNS validation certs auto-renew silently; email certs require manual renewal every 13 months.' },
  aurora_cluster:    { source: 'terraform-aws-modules/rds-aurora/aws',       version: '~> 9.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/rds-aurora/aws/latest',   what: 'Creates Aurora cluster with cluster instances, subnet group, parameter group, and enhanced monitoring.', how: ['Use engine=aurora-postgresql or aurora-mysql.', 'Set instances = { 1 = {}, 2 = {} } for Multi-AZ.', 'serverlessv2_scaling_configuration enables Aurora Serverless v2.'], tip: 'Aurora Serverless v2 scales in 0.5 ACU increments — ideal for variable workloads.' },
  elasticache:       { source: 'terraform-aws-modules/elasticache/aws',      version: '~> 1.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/elasticache/aws/latest',  what: 'Creates ElastiCache Redis or Memcached clusters with replication groups, subnet groups, and parameter groups.', how: ['Set cluster_mode_enabled=true for Redis cluster mode.', 'Use at_rest_encryption_enabled=true and transit_encryption_enabled=true.', 'auth_token is required when transit encryption is on.'], tip: 'Choose Redis 7.x for cluster mode — it supports more commands and has better memory efficiency.' },
  auto_scaling_group:{ source: 'terraform-aws-modules/autoscaling/aws',      version: '~> 7.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/autoscaling/aws/latest', what: 'Creates Auto Scaling Group with launch template, scaling policies, lifecycle hooks, and CloudWatch alarms.', how: ['Use mixed_instances_policy for Spot + On-Demand mix.', 'Set protect_from_scale_in=true on instances handling long jobs.', 'target_tracking_scaling_policies track CPU or custom metrics.'], tip: 'Use instance_refresh with min_healthy_percentage=50 for zero-downtime deployments.' },
  ecs_cluster:       { source: 'terraform-aws-modules/ecs/aws',              version: '~> 5.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/ecs/aws/latest',          what: 'Creates ECS cluster with optional Fargate/EC2 capacity providers and Container Insights enabled.',       how: ['Use fargate_capacity_providers for serverless containers.', 'Enable container_insights for CloudWatch metrics on tasks.', 'Define services inside the cluster module for a unified config.'],   tip: 'Fargate Spot gives 70% savings for fault-tolerant batch workloads.' },
  step_functions:    { source: 'terraform-aws-modules/step-functions/aws',   version: '~> 2.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/step-functions/aws/latest',what: 'Creates Step Functions state machine with IAM role, X-Ray tracing, and CloudWatch logging.',              how: ['Set type=EXPRESS for high-throughput workflows (100k/s, no state history).', 'Set type=STANDARD for long-running workflows needing execution history.', 'Use definition_substitutions to reference ARNs.'], tip: 'Express workflows are 10x cheaper than Standard — use them for event-driven orchestration.' },
  transit_gateway:   { source: 'terraform-aws-modules/transit-gateway/aws',  version: '~> 2.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/transit-gateway/aws/latest',what: 'Creates Transit Gateway with VPC attachments, route tables, and RAM sharing for multi-account networking.', how: ['Share with AWS RAM across accounts using share_tgw=true.', 'Each VPC attachment needs its own route table entry.', 'enable_default_route_table_association=false for strict routing.'], tip: 'Use TGW instead of VPC peering for mesh connectivity with >3 VPCs — peering is O(n²), TGW is hub-and-spoke.' },
  msk_cluster:       { source: 'terraform-aws-modules/msk/aws',              version: '~> 2.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/msk/aws/latest',          what: 'Creates MSK Kafka cluster with broker nodes, encryption, authentication, and CloudWatch monitoring.',     how: ['Set number_of_broker_nodes to a multiple of AZ count.', 'Use kafka_version 3.5.1+ for latest features.', 'client_authentication.sasl.iam=true for IAM auth.'],                              tip: 'Enable enhanced monitoring (PER_BROKER) from day one — you cannot change it without recreating the cluster.' },
  memorydb_cluster:  { source: 'terraform-aws-modules/memory-db/aws',        version: '~> 1.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/memory-db/aws/latest',    what: 'Creates MemoryDB for Redis cluster with multi-AZ, snapshots, and subnet group.',                         how: ['MemoryDB is durable unlike ElastiCache — data survives restarts.', 'Set num_replicas_per_shard≥1 for HA.', 'tls_enabled=true is enforced; cannot be changed after creation.'],              tip: 'Use MemoryDB when you need Redis as a primary database, not just a cache.' },
  opensearch_domain: { source: 'terraform-aws-modules/opensearch/aws',       version: '~> 1.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/opensearch/aws/latest',   what: 'Creates Amazon OpenSearch domain with VPC, encryption, access policies, and Kibana.',                     how: ['Place in VPC with dedicated master nodes for production.', 'Set engine_version to OpenSearch_2.x.', 'Use advanced_security_options for fine-grained access control.'],                       tip: 'Use t3.small for dev/test; for production use at least m6g.large with dedicated master nodes.' },
  batch_compute_environment: { source: 'terraform-aws-modules/batch/aws',    version: '~> 2.0', registry: 'https://registry.terraform.io/modules/terraform-aws-modules/batch/aws/latest',        what: 'Creates AWS Batch compute environment, job queue, and job definition as a complete unit.',                how: ['Use SPOT for cost savings on fault-tolerant jobs.', 'Set allocation_strategy=BEST_FIT_PROGRESSIVE for Spot.', 'Define resource_requirements in job_definition for CPU/memory.'],            tip: 'Combine ON_DEMAND base capacity + SPOT burst in the same job queue for reliability at lower cost.' },
};

const ROADMAP_STEP = {
  'Compute':        { step: 'Step 4-5', label: 'EC2, Auto Scaling, ALB', color: '#818CF8' },
  'Storage':        { step: 'Step 5',   label: 'S3, EBS, EFS',           color: '#34D399' },
  'Networking':     { step: 'Step 3',   label: 'VPC Deep Dive',           color: '#38BDF8' },
  'Database':       { step: 'Step 6',   label: 'RDS + DynamoDB',          color: '#C084FC' },
  'IAM & Security': { step: 'Step 2',   label: 'IAM — Master First',      color: '#FB7185' },
  'Monitoring':     { step: 'Step 7',   label: 'CloudWatch + Alarms',     color: '#86EFAC' },
  'Containers':     { step: 'Step 10',  label: 'ECS + EKS + ECR',         color: '#22D3EE' },
  'CI/CD':          { step: 'Step 9',   label: 'CodePipeline + Build',    color: '#FCD34D' },
  'Admin & Ops':    { step: 'Step 9-12',label: 'SysOps Path',             color: '#A78BFA' },
  'Analytics':       { step: 'Step 11', label: 'Kinesis, Glue, Athena',   color: '#F97316' },
  'App Integration': { step: 'Step 12', label: 'Step Functions, Cognito', color: '#14B8A6' },
  'Machine Learning':{ step: 'Step 13', label: 'SageMaker + Bedrock',     color: '#EC4899' },
};

// --- Field grouping by service type ------------------------------------------
const FIELD_GROUPS = {
  ec2: [
    { id: 'compute', label: '🖥 Compute',        icon: '🖥', fields: ['ami_id', 'instance_type', 'user_data'] },
    { id: 'network', label: '🌐 Network',        icon: '🌐', fields: ['subnet_id', 'vpc_security_group_ids', 'security_group_ids', 'associate_public_ip_address', 'availability_zone'] },
    { id: 'access',  label: '🔑 Access',         icon: '🔑', fields: ['key_name', 'iam_instance_profile'] },
    { id: 'storage', label: '💾 Storage',        icon: '💾', fields: ['root_volume_size', 'root_volume_type', 'volume_size', 'volume_type', 'encrypted', 'ebs_optimized'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'monitoring', 'description'] },
  ],
  rds: [
    { id: 'engine',  label: '⚙ Engine',          icon: '⚙', fields: ['engine', 'engine_version'] },
    { id: 'compute', label: '🖥 Instance',       icon: '🖥', fields: ['instance_class', 'allocated_storage', 'max_allocated_storage', 'storage_type'] },
    { id: 'network', label: '🌐 Network',        icon: '🌐', fields: ['subnet_group_name', 'db_subnet_group_name', 'vpc_security_group_ids', 'availability_zone', 'multi_az', 'publicly_accessible'] },
    { id: 'auth',    label: '🔑 Auth',           icon: '🔑', fields: ['username', 'password', 'db_name', 'port'] },
    { id: 'safety',  label: '🛡 Safety & Backup', icon: '🛡', fields: ['storage_encrypted', 'kms_key_id', 'deletion_protection', 'skip_final_snapshot', 'final_snapshot_identifier', 'backup_retention_period', 'backup_window'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'description'] },
  ],
  vpc: [
    { id: 'network', label: '🌐 Network',        icon: '🌐', fields: ['cidr_block', 'enable_dns_support', 'enable_dns_hostnames'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'description'] },
  ],
  subnet: [
    { id: 'network', label: '🌐 Network',        icon: '🌐', fields: ['vpc_id', 'cidr_block', 'availability_zone', 'map_public_ip_on_launch'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'description'] },
  ],
  security_group: [
    { id: 'basic',   label: '🛡 Basic',           icon: '🛡', fields: ['name', 'description', 'vpc_id'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  alb_target_group: [
    { id: 'basic',   label: '🎯 Target',          icon: '🎯', fields: ['name', 'tg_name', 'port', 'protocol', 'target_type'] },
    { id: 'network', label: '🌐 Network',         icon: '🌐', fields: ['vpc_id', 'deregistration_delay'] },
    { id: 'health',  label: '❤️ Health Check',    icon: '❤️', fields: ['health_check_path'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  alb_listener: [
    { id: 'basic',   label: '👂 Listener',        icon: '👂', fields: ['name', 'port', 'protocol', 'ssl_policy'] },
    { id: 'routing', label: '🔀 Routing',         icon: '🔀', fields: ['lb_arn', 'target_group_arn', 'certificate_arn'] },
  ],
  db_subnet_group: [
    { id: 'basic',   label: '🔗 Basic',           icon: '🔗', fields: ['name', 'group_name', 'description'] },
    { id: 'network', label: '🌐 Subnets',         icon: '🌐', fields: ['subnet_ids'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  db_parameter_group: [
    { id: 'basic',   label: '⚙️ Engine',          icon: '⚙️', fields: ['name', 'group_name', 'family', 'description'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  sagemaker_domain: [
    { id: 'basic',   label: '🏠 Domain',          icon: '🏠', fields: ['name', 'domain_name', 'auth_mode'] },
    { id: 'network', label: '🌐 Network',         icon: '🌐', fields: ['vpc_id', 'subnet_ids'] },
    { id: 'compute', label: '🖥 Compute',         icon: '🖥', fields: ['execution_role_arn', 'instance_type'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  lambda_event_source_mapping: [
    { id: 'basic',   label: '⚡ Trigger',         icon: '⚡', fields: ['name', 'event_source_arn', 'function_name'] },
    { id: 'config',  label: '⚙️ Config',          icon: '⚙️', fields: ['batch_size', 'enabled', 'bisect_on_error'] },
  ],
  eks_addon: [
    { id: 'basic',   label: '🧩 Add-on',          icon: '🧩', fields: ['name', 'addon_name', 'cluster_name'] },
    { id: 'config',  label: '⚙️ Config',          icon: '⚙️', fields: ['resolve_conflicts', 'service_account_role_arn'] },
    { id: 'meta',    label: '🏷 Tags',            icon: '🏷', fields: ['tags'] },
  ],
  scheduler_schedule: [
    { id: 'basic',   label: '⏰ Schedule',        icon: '⏰', fields: ['name', 'schedule_name', 'schedule_expression', 'timezone'] },
    { id: 'target',  label: '🎯 Target',          icon: '🎯', fields: ['target_arn', 'role_arn', 'group_name'] },
  ],
  ses_configuration_set: [
    { id: 'basic',   label: '📧 Config',          icon: '📧', fields: ['name', 'config_name', 'tls_policy', 'sending_enabled'] },
    { id: 'events',  label: '📣 Events',          icon: '📣', fields: ['sns_topic_arn'] },
  ],
  s3: [
    { id: 'bucket',  label: '🪣 Bucket',          icon: '🪣', fields: ['bucket', 'acl'] },
    { id: 'safety',  label: '🔒 Security',        icon: '🔒', fields: ['versioning', 'encryption', 'force_destroy', 'block_public_access', 'block_public_acls'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'description'] },
  ],
  lambda: [
    { id: 'function', label: 'λ Function',        icon: 'λ', fields: ['function_name', 'runtime', 'handler', 'filename', 's3_bucket', 's3_key'] },
    { id: 'config',   label: '⚙ Configuration',  icon: '⚙', fields: ['memory_size', 'timeout', 'environment'] },
    { id: 'network',  label: '🌐 Network',        icon: '🌐', fields: ['subnet_ids', 'security_group_ids', 'vpc_id'] },
    { id: 'access',   label: '👤 IAM',            icon: '👤', fields: ['role', 'role_arn'] },
    { id: 'meta',     label: '🏷 Tags & Meta',    icon: '🏷', fields: ['name', 'tags', 'description'] },
  ],
  alb: [
    { id: 'basic',   label: '⚖ Load Balancer',   icon: '⚖', fields: ['name', 'internal', 'load_balancer_type'] },
    { id: 'network', label: '🌐 Network',        icon: '🌐', fields: ['subnets', 'subnet_ids', 'security_groups', 'vpc_id'] },
    { id: 'meta',    label: '🏷 Tags & Meta',    icon: '🏷', fields: ['tags', 'description'] },
  ],
};

// --- Field inline help text --------------------------------------------------
const FIELD_INLINE_HELP = {
  ami_id:                     'OS image for your instance (e.g. Ubuntu, Amazon Linux)',
  instance_type:              'CPU + RAM size — t3.micro is free-tier eligible',
  key_name:                   'SSH key for remote access — create one in the AWS Console',
  subnet_id:                  'Network segment where this resource lives',
  vpc_security_group_ids:     'Firewalls controlling allowed traffic to this resource',
  associate_public_ip_address:'true = internet-accessible, false = internal only',
  cidr_block:                 'IP address range (e.g. 10.0.0.0/16 → 65,536 IPs)',
  availability_zone:          'Specific AWS data center — use 2+ for fault tolerance',
  map_public_ip_on_launch:    'Auto-assigns public IP to instances in this subnet',
  engine:                     'Database type: postgres, mysql, mariadb, etc.',
  instance_class:             'CPU + RAM for the database server',
  multi_az:                   'true = automatic failover replica in another data center',
  deletion_protection:        'Prevents accidental deletion — disable before terraform destroy',
  storage_encrypted:          'Encrypts data at rest — always enable for production',
  skip_final_snapshot:        'false = take backup before deletion (recommended for prod)',
  backup_retention_period:    'Days to keep automated backups (7 = good default)',
  allocated_storage:          'Initial disk size in GB',
  runtime:                    'Language version (e.g. nodejs20.x, python3.12)',
  handler:                    'Entry point: filename.function_name',
  memory_size:                'MB of RAM (CPU scales proportionally)',
  timeout:                    'Max execution time in seconds (max 900)',
  bucket:                     'Globally unique name — will be part of the URL',
  force_destroy:              '⚠ Allows deletion of bucket with objects still inside',
  versioning:                 'Keep all versions of objects for recovery',
  vpc_id:                     'The VPC this resource belongs to',
  name:                       'Resource name — appears as the Name tag in AWS',
  monitoring:                 'Enable detailed CloudWatch monitoring (1-min intervals)',
  user_data:                  'Startup script that runs once when instance first boots',
  encrypted:                  'Encrypt storage at rest with AES-256',
  volume_size:                'Disk size in GB',
  volume_type:                'Performance tier: gp3 (recommended), gp2, io1, io2',
  root_volume_size:           'Root disk size in GB',
  root_volume_type:           'Root disk performance tier (gp3 recommended)',
  iam_instance_profile:       'IAM role granting this instance AWS permissions',
  ebs_optimized:              'Dedicated throughput between EC2 and EBS',
  description:                'Human-readable description of this resource',
  tags:                       'Key-value labels for billing, filtering, and organization',
  port:                       'TCP port the database listens on',
  username:                   'Master database username',
  password:                   'Master database password — use Secrets Manager in prod',
  publicly_accessible:        '⚠ true = database reachable from internet',
  internal:                   'true = internal-only LB, false = internet-facing',
}

// --- Validation warnings -----------------------------------------------------
function getFieldWarning(fieldId, value) {
  if (!value && value !== false && value !== 0) return null;
  const v = String(value);
  const WARNINGS = {
    associate_public_ip_address: v === 'true' && '⚠ Directly reachable from internet — use ALB in production',
    publicly_accessible:   v === 'true' && '⚠ Database accessible from internet — restrict to private subnet',
    deletion_protection:   v === 'false' && '⚠ Can be accidentally destroyed — enable for production',
    storage_encrypted:     v === 'false' && '⚠ Data not encrypted at rest — always enable encryption',
    skip_final_snapshot:   v === 'true' && '⚠ No backup on deletion — all data permanently lost',
    force_destroy:         v === 'true' && '⚠ All objects deleted when bucket is destroyed',
    encrypted:             v === 'false' && '⚠ Storage not encrypted — enable for security compliance',
    multi_az:              v === 'false' && 'ℹ No automatic failover — enable for production databases',
    backup_retention_period: v === '0' && '⚠ Automated backups disabled — no point-in-time recovery',
  };
  return WARNINGS[fieldId] || null;
}

// --- SG Rules → HCL serializer -----------------------------------------------
function generateSgRulesHCL(rules, sgName) {
  if (!Array.isArray(rules) || !rules.length) return '';
  return rules.map((r, i) => {
    const cidrs = r.cidr_blocks ? `cidr_blocks = [${r.cidr_blocks.split(',').map(s => `"${s.trim()}"`).join(', ')}]` : '';
    const ipv6  = r.ipv6_cidr  ? `ipv6_cidr_blocks = ["${r.ipv6_cidr.trim()}"]` : '';
    const srcSg = r.source_sg  ? `source_security_group_id = ${r.source_sg}` : '';
    const ports = r.protocol === '-1' ? '' : `  from_port   = ${r.from_port || 0}\n  to_port     = ${r.to_port || 0}`;
    const desc  = r.description ? `  description = "${r.description}"` : '';
    return `resource "aws_security_group_rule" "${sgName}_${r.direction}_${i + 1}" {
  type              = "${r.direction}"
  security_group_id = aws_security_group.${sgName}.id
  protocol          = "${r.protocol}"
${ports}
${[cidrs, ipv6, srcSg, desc].filter(Boolean).map(l => '  ' + l).join('\n')}
}`;
  }).join('\n\n');
}

// --- Subnets → HCL serializer ------------------------------------------------
function generateSubnetsHCL(subnets, vpcName) {
  if (!Array.isArray(subnets) || !subnets.length) return '';
  return subnets.map((s, i) => {
    const resName = s.name ? s.name.replace(/[^a-z0-9_]/gi, '_') : `${s.type}_subnet_${i}`;
    return `resource "aws_subnet" "${resName}" {
  vpc_id                  = aws_vpc.${vpcName}.id
  cidr_block              = "${s.cidr || `10.0.${i}.0/24`}"${s.az ? `\n  availability_zone       = "${s.az}"` : ''}
  map_public_ip_on_launch = ${s.map_public_ip !== false ? 'true' : 'false'}

  tags = {
    Name = "${s.name || resName}"
    Type = "${s.type}"
  }
}`;
  }).join('\n\n');
}

// --- EC2 instances → HCL serializer -----------------------------------------
function generateEc2HCL(instances) {
  if (!Array.isArray(instances) || !instances.length) return '';
  return instances.map((inst, i) => {
    const resName = inst.name ? inst.name.replace(/[^a-z0-9_]/gi, '_') : `instance_${i + 1}`;
    // Normalize subnet reference: if it's a terraform resource reference (e.g. aws_subnet.name.id
    // or module.xxx), emit unquoted; otherwise quote it so HCL remains valid.
    let subnetLine = '';
    if (inst.subnet_ref) {
      const sr = String(inst.subnet_ref).trim();
      const isRef = /^(aws_[a-z0-9_]+\.[A-Za-z0-9_]+\.id|module\.[A-Za-z0-9_]+)/.test(sr);
      subnetLine = isRef ? `  subnet_id     = ${sr}` : `  subnet_id     = "${sr}"`;
    }

    const lines = [
      `  ami           = "${inst.ami_id || 'data.aws_ami.latest.id'}"`,
      `  instance_type = "${inst.instance_type || 't3.micro'}"`,
      subnetLine,
      inst.key_name    && `  key_name      = "${inst.key_name}"`,
      `  associate_public_ip_address = ${inst.associate_public_ip ? 'true' : 'false'}`,
      `  monitoring    = ${inst.monitoring ? 'true' : 'false'}`,
      inst.user_data   && `  user_data     = base64encode(<<-EOF\n    ${inst.user_data.trim()}\n  EOF\n  )`,
      `\n  root_block_device {\n    volume_size = ${inst.root_volume_size || 20}\n    volume_type = "${inst.root_volume_type || 'gp3'}"\n    encrypted   = true\n  }`,
      `\n  tags = { Name = "${inst.name || resName}" }`,
    ].filter(Boolean).join('\n');
    return `resource "aws_instance" "${resName}" {\n${lines}\n}`;
  }).join('\n\n');
}

export default function ConfigPanel({ service, config, onChange, isModule, onToggleModule, region, allResources }) {
  const { c } = useTheme();

  if (!service) return <EmptyState c={c} />;

  const handleChange = (fieldId, value) => {
    const newConfig = { ...config, [fieldId]: value };
    const templateBody = isModule ? service.module_body : service.template_body;
    let hcl = templateBody ? generateHCL(templateBody, newConfig) : '';

    // SG rules — re-append on every field change so rules stay in sync
    if (service.service_type === 'security_group' &&
        Array.isArray(newConfig.sg_rules_multi) && newConfig.sg_rules_multi.length > 0) {
      hcl = hcl + '\n\n' + generateSgRulesHCL(newConfig.sg_rules_multi, newConfig.name || 'my_sg');
    }
    // Subnet multi — re-append on every field change so parent vpc_id references stay current
    if (service.service_type === 'subnet' &&
        Array.isArray(newConfig.subnets_multi) && newConfig.subnets_multi.length > 0) {
      hcl = hcl + '\n\n' + generateSubnetsHCL(newConfig.subnets_multi, newConfig.vpc_id || 'my_vpc');
    }
    // EC2 additional instances — re-append on every field change
    if (service.service_type === 'ec2' &&
        Array.isArray(newConfig.ec2_instances_multi) && newConfig.ec2_instances_multi.length > 0) {
      hcl = hcl + '\n\n' + generateEc2HCL(newConfig.ec2_instances_multi);
    }

    onChange(newConfig, hcl);
  };

  const canModule = !!service.module_body;
  const roadmap   = ROADMAP_STEP[service.category];
  const catMeta   = { 'Compute':'#818CF8','Storage':'#34D399','Networking':'#38BDF8','Database':'#C084FC','IAM & Security':'#FB7185','Monitoring':'#86EFAC','Containers':'#22D3EE','CI/CD':'#FCD34D','Admin & Ops':'#A78BFA','Analytics':'#F97316','App Integration':'#14B8A6','Machine Learning':'#EC4899' };
  const catColor  = catMeta[service.category] || c.accent;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: c.bg }}>
      {/* Panel Header */}
      <div style={{ padding: '14px 16px 12px', borderBottom: `1px solid ${c.bd}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: catColor, flexShrink: 0 }} />
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: c.fg, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {service.label}
              </h2>
            </div>
            <div style={{ fontSize: 11, color: c.fg3, fontFamily: 'JetBrains Mono, monospace' }}>
              {service.service_type} · <span style={{ color: catColor }}>{service.category}</span>
            </div>
          </div>

          {/* Module toggle */}
          {canModule && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 10 }}>
              <span style={{ fontSize: 10, color: isModule ? c.accent : c.fg3, fontWeight: 600, transition: 'color 0.2s' }}>MODULE</span>
              <button onClick={onToggleModule} style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                background: isModule ? c.accent : c.bd2,
                cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: isModule ? 18 : 2,
                  width: 16, height: 16, borderRadius: 8, background: '#fff',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                }} />
              </button>
            </div>
          )}
        </div>

        {/* Badges row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {roadmap && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: catColor + '14', border: `1px solid ${catColor}33`, borderRadius: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: catColor }}>{roadmap.step}</span>
              <span style={{ fontSize: 10, color: c.fg3 }}>{roadmap.label}</span>
            </div>
          )}
          {isModule && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: c.accent + '14', border: `1px solid ${c.accent}33`, borderRadius: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: c.accent }}>📦 Module Mode</span>
            </div>
          )}
        </div>
      </div>

      {/* Module active banner */}
      {isModule && (
        <div style={{ padding: '8px 16px', background: c.accent + '12', borderBottom: `1px solid ${c.accent}25`, fontSize: 12, color: c.accent, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span>*</span>
          <span>Using official Terraform registry module — source and version are auto-included.</span>
        </div>
      )}

      {/* Fields — grouped by section when available */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <GroupedFields
          service={service}
          config={config}
          handleChange={handleChange}
          region={region}
          c={c}
        />

        {/* Auto-inject SG rules editor for security_group resources */}
        {service.service_type === 'security_group' && (
          <div>
            <div style={{ height: 1, background: c.bd, margin: '4px 0 12px' }} />
            <MultiResourcePanel
              type="sg_rules"
              value={Array.isArray(config.sg_rules_multi) ? config.sg_rules_multi : []}
              onChange={val => handleChange('sg_rules_multi', val)}
              c={c}
              allResources={allResources}
            />
          </div>
        )}

        {/* Auto-inject Subnet multi-editor for subnet resources */}
        {service.service_type === 'subnet' && (
          <div>
            <div style={{ height: 1, background: c.bd, margin: '4px 0 12px' }} />
            <MultiResourcePanel
              type="subnets"
              items={Array.isArray(config.subnets_multi) ? config.subnets_multi : []}
              onChange={val => handleChange('subnets_multi', val)}
              region={region}
              c={c}
              allResources={allResources}
              vpcId={config.vpc_id}
            />
          </div>
        )}

        {/* Auto-inject multi-instance panel for ec2 resources */}
        {service.service_type === 'ec2' && (
          <div>
            <div style={{ height: 1, background: c.bd, margin: '4px 0 12px' }} />
            <MultiResourcePanel
              type="ec2_instances"
              items={Array.isArray(config.ec2_instances_multi) ? config.ec2_instances_multi : []}
              onChange={val => handleChange('ec2_instances_multi', val)}
              region={region}
              c={c}
              allResources={allResources}
              vpcId={config.vpc_id}
            />
          </div>
        )}

        {(service.schema_def || []).length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: c.fg3, fontSize: 13 }}>
            No configuration fields for this resource.
          </div>
        )}

        {/* ── Lifecycle: prevent_destroy (stateful resources) ── */}
        {STATEFUL_TYPES.has(service.service_type) && (
          <LifecyclePanel config={config} handleChange={handleChange} c={c} />
        )}

        {/* Module Help */}
        {isModule && canModule && <ModuleHelpPanel serviceType={service.service_type} c={c} />}

        {/* Module available hint */}
        {!isModule && canModule && (
          <div style={{ marginTop: 8, padding: '9px 12px', background: c.accent + '0E', border: `1px solid ${c.accent}25`, borderRadius: 8, fontSize: 12, color: c.fg2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📦</span>
            <span>Official Terraform module available — toggle <strong style={{ color: c.accent }}>MODULE</strong> above to use it.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Grouped Fields Component -------------------------------------------------
function GroupedFields({ service, config, handleChange, region, c }) {
  const groups = FIELD_GROUPS[service.service_type];
  const schema = service.schema_def || [];

  if (!groups || schema.length === 0) {
    // No grouping — render flat
    return (
      <>
        {schema.map((field, idx) => (
          <FieldRow key={field.id} field={field} value={config[field.id] ?? field.default ?? ''} onChange={val => handleChange(field.id, val)} region={region} c={c} wiredFrom={service?.wiredFrom?.[field.id]} isFirst={idx === 0} />
        ))}
      </>
    );
  }

  // Group fields — put any field not in a group into an "Other" section
  const grouped = groups.map(g => ({
    ...g,
    fieldDefs: g.fields
      .map(fid => schema.find(f => f.id === fid))
      .filter(Boolean),
  })).filter(g => g.fieldDefs.length > 0);

  const assignedIds = new Set(groups.flatMap(g => g.fields));
  const ungrouped = schema.filter(f => !assignedIds.has(f.id));
  if (ungrouped.length > 0) {
    grouped.push({ id: 'other', label: '⚙ Other', icon: '⚙', fieldDefs: ungrouped });
  }

  return (
    <>
      {grouped.map((group, gi) => (
        <FieldGroup key={group.id} group={group} config={config} handleChange={handleChange}
          region={region} c={c} service={service} defaultOpen={gi < 3} />
      ))}
    </>
  );
}

function FieldGroup({ group, config, handleChange, region, c, service, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const warnings = group.fieldDefs.filter(f => getFieldWarning(f.id, config[f.id]));
  const filled   = group.fieldDefs.filter(f => config[f.id] && String(config[f.id]).trim() !== '');

  return (
    <div style={{ border: `1px solid ${c.bd}`, borderRadius: 10, overflow: 'visible' }}>
      {/* Group header */}
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 12px', background: c.bg2, border: 'none', cursor: 'pointer',
        borderBottom: open ? `1px solid ${c.bd}` : 'none', textAlign: 'left',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: c.fg, flex: 1 }}>{group.label}</span>
        {/* Progress + warnings */}
        <span style={{ fontSize: 10, color: c.fg3 }}>
          {filled.length}/{group.fieldDefs.length}
        </span>
        {warnings.length > 0 && (
          <span style={{ fontSize: 10, color: '#ef4444', background: '#ef444415', padding: '1px 6px', borderRadius: 8 }}>
            ⚠ {warnings.length}
          </span>
        )}
        <span style={{ fontSize: 11, color: c.fg3, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>

      {/* Group fields */}
      {open && (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {group.fieldDefs.map((field, idx) => (
            <FieldRow key={field.id} field={field} value={config[field.id] ?? field.default ?? ''} onChange={val => handleChange(field.id, val)} region={region} c={c} wiredFrom={service?.wiredFrom?.[field.id]} isFirst={idx === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Field Row ----------------------------------------------------------------
function FieldRow({ field, value, onChange, region, c, wiredFrom }) {
  const warning = getFieldWarning(field.id, value);
  const inlineHelp = FIELD_INLINE_HELP[field.id];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: c.fg, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {field.label}
        </span>
        {field.required && <span style={{ color: c.err, fontSize: 10 }}>✱</span>}
        {field.description && (
          <Tooltip text={field.description} c={c}>
            <span style={{ fontSize: 10, color: c.fg3, cursor: 'help', border: `1px solid ${c.bd2}`, borderRadius: '50%', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>?</span>
          </Tooltip>
        )}
        {wiredFrom && (
          <span style={{ marginLeft: 'auto', fontSize: 9.5, color: c.ok, background: c.ok + '15', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', fontWeight: 600 }}>
            ⇢ auto-wired
          </span>
        )}
      </label>

      {/* Inline help text */}
      {inlineHelp && (
        <div style={{ fontSize: 11, color: c.fg3, paddingLeft: 0, lineHeight: 1.5, wordWrap: 'break-word', whiteSpace: 'normal' }}>
          💡 {inlineHelp}
        </div>
      )}

      {field.type === 'select' ? (
        <DynamicSelect field={field} region={region} value={value} onChange={onChange} c={c} />
      ) : field.type === 'number' ? (
        <input type="number" value={value} onChange={e => onChange(e.target.value)}
          className="field-input"
          style={{ background: c.inputBg, border: `1px solid ${warning ? '#ef4444' : c.bd}`, borderRadius: 6, color: c.fg, padding: '7px 10px', fontSize: 13, fontFamily: 'JetBrains Mono, monospace', outline: 'none', width: '100%', boxSizing: 'border-box' }}
          onFocus={e => { e.target.style.borderColor = c.accent; e.target.style.boxShadow = `0 0 0 3px ${c.accent}20`; }}
          onBlur={e => { e.target.style.borderColor = warning ? '#ef4444' : c.bd; e.target.style.boxShadow = 'none'; }}
        />
      ) : field.id === 'ami_id' ? (
        <AmiInput region={region} value={value} onChange={onChange} c={c} />
      ) : field.id === 'subnets_multi' ? (
        <MultiResourcePanel type="subnets" items={Array.isArray(value) ? value : []} onChange={onChange} region={region} c={c} />
      ) : field.id === 'ec2_instances_multi' ? (
        <MultiResourcePanel type="ec2_instances" items={Array.isArray(value) ? value : []} onChange={onChange} region={region} c={c} />
      ) : field.id === 'sg_rules_multi' ? (
        <MultiResourcePanel type="sg_rules" value={Array.isArray(value) ? value : []} onChange={onChange} c={c} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder || field.default || ''}
          style={{ background: c.inputBg, border: `1px solid ${warning ? '#ef4444' : c.bd}`, borderRadius: 6, color: c.fg, padding: '7px 10px', fontSize: 13, fontFamily: 'JetBrains Mono, monospace', outline: 'none', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s' }}
          onFocus={e => { e.target.style.borderColor = c.accent; e.target.style.boxShadow = `0 0 0 3px ${c.accent}20`; }}
          onBlur={e => { e.target.style.borderColor = warning ? '#ef4444' : c.bd; e.target.style.boxShadow = 'none'; }}
        />
      )}

      {/* Validation warning */}
      {warning && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}>
          {warning}
        </div>
      )}

      {wiredFrom && (
        <div style={{ marginTop: 4, fontSize: 11, color: c.fg3 }}>
          Auto-filled from <span style={{ color: c.ok }}>{wiredFrom.sourceLabel}</span>
        </div>
      )}
    </div>
  );
}

// --- Tooltip ------------------------------------------------------------------
function Tooltip({ text, c, children }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div style={{
          position: 'absolute', bottom: '120%', left: '50%', transform: 'translateX(-50%)',
          background: c.bg4, border: `1px solid ${c.bd2}`, borderRadius: 6, padding: '5px 9px',
          fontSize: 11, color: c.fg2, whiteSpace: 'nowrap', maxWidth: 220, zIndex: 100,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

// --- DynamicSelect ------------------------------------------------------------
function DynamicSelect({ field, value, onChange, region, c }) {
  const [opts, setOpts]       = useState(field.options || []);
  const [loading, setLoading] = useState(false);
  const [source, setSource]   = useState('');

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (field.id !== 'instance_type' && field.id !== 'availability_zone') return;
      setLoading(true);
      try {
        const r = field.id === 'availability_zone'
          ? await awsAPI.availabilityZones(region || 'ap-south-1')
          : await awsAPI.instanceTypes(region || 'ap-south-1');
        if (!mounted) return;
        const data = field.id === 'availability_zone'
          ? r.data?.zones || []
          : r.data?.instance_types || [];
        // AZs: live list is authoritative per region — don't blend with stale static
        // Instance types: merge live + curated for completeness
        const merged = field.id === 'availability_zone'
          ? (data.length ? data : (field.options || []))
          : Array.from(new Set([...data, ...(field.options || [])]));
        setOpts(merged);
        setSource(r.data?.source || 'curated');
      } catch (_) {
        // silently fall back to static list already in state
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  // Re-fetch when region changes so AZs always match selected region
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, region]);

  const selectStyle = {
    background: c.inputBg, border: `1px solid ${c.bd}`, borderRadius: 6,
    color: c.fg, padding: '7px 10px', fontSize: 13,
    fontFamily: 'JetBrains Mono, monospace', outline: 'none', width: '100%',
    boxSizing: 'border-box', cursor: 'pointer', transition: 'border-color 0.15s',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%237A8BA8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
    paddingRight: 30,
  };

  return (
    <div>
      <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}
        onFocus={e => { e.target.style.borderColor = c.accent; e.target.style.boxShadow = `0 0 0 3px ${c.accent}20`; }}
        onBlur={e => { e.target.style.borderColor = c.bd; e.target.style.boxShadow = 'none'; }}>
        {loading
          ? <option disabled>Loading from AWS…</option>
          : opts.map(opt => <option key={opt} value={opt}>{opt}</option>)
        }
      </select>
      {source && (
        <div style={{ marginTop: 3, fontSize: 10.5, color: source === 'aws' ? '#4ade80' : c.fg3 }}>
          {source === 'aws' ? '🟢 Live from AWS API' : '📋 Curated — connect AWS credentials for live data'}
        </div>
      )}
    </div>
  );
}

// --- AmiInput -----------------------------------------------------------------
function AmiInput({ region, value, onChange, c }) {
  const [q, setQ]             = useState('');
  const [list, setList]       = useState([]);
  const [open, setOpen]       = useState(false);
  const [searching, setSearching] = useState(false);
  const [source, setSource]   = useState('');
  const dropdownRef           = useRef(null);
  // FIX: cancelClose ref lets any element inside the dropdown cancel the
  // onBlur timer that would close it when focus moves within the panel.
  const closeTimer            = useRef(null);

  useEffect(() => { setQ(''); setList([]); setSource(''); }, [region]);

  useEffect(() => {
    if (!open) return;
    fetchAmis('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, region]);

  // FIX: clean up the timer if the component unmounts while it is pending.
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function scheduleClose() {
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  }
  function cancelClose() {
    clearTimeout(closeTimer.current);
  }

  async function fetchAmis(term) {
    setSearching(true);
    try {
      const r = await awsAPI.amis(region || 'ap-south-1', term);
      setList(r.data?.images || []);
      setSource(r.data?.source || '');
    } catch (_) { setList([]); }
    finally { setSearching(false); }
  }

  const inputStyle = {
    background: c.inputBg, border: `1px solid ${c.bd}`, borderRadius: 6,
    color: c.fg, padding: '7px 10px', fontSize: 13,
    fontFamily: 'JetBrains Mono, monospace', outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'relative' }}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder="ami-… or click to browse"
        onFocus={() => { cancelClose(); setOpen(true); }}
        onBlur={scheduleClose}
        style={inputStyle}
        onMouseEnter={e => e.target.style.borderColor = c.bd2}
        onMouseLeave={e => !open && (e.target.style.borderColor = c.bd)}
      />
      {open && (
        <div ref={dropdownRef} style={{
          position: 'absolute', right: 0, left: 0, top: 'calc(100% + 4px)',
          background: c.bg3, border: `1px solid ${c.bd2}`, borderRadius: 10,
          zIndex: 99, maxHeight: 320, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        }}>
          {/* Search bar */}
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${c.bd}`, display: 'flex', gap: 6 }}>
            <input placeholder="Search AMIs…" value={q}
              onChange={e => setQ(e.target.value)}
              // FIX: cancel the blur-close timer when the user focuses the
              // search box, and reschedule it when they leave it.
              onFocus={cancelClose}
              onBlur={scheduleClose}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fetchAmis(q); } }}
              style={{ ...inputStyle, flex: 1, fontSize: 12, borderRadius: 6, padding: '5px 8px' }}
            />
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => fetchAmis(q)}
              style={{ padding: '5px 10px', background: c.accent, color: '#001A0F', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>
              {searching ? '…' : 'Search'}
            </button>
          </div>

          {/* Source badge */}
          {source && (
            <div style={{ padding: '4px 12px', fontSize: 10.5, color: c.fg3, background: c.bg2, borderBottom: `1px solid ${c.bd}` }}>
              {source === 'aws' ? '🟢 Live from AWS API' : '📋 Curated — connect AWS creds for live results'}
            </div>
          )}

          {/* Results */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {searching && <div style={{ padding: '16px', textAlign: 'center', color: c.fg3, fontSize: 12 }}>Searching AMIs…</div>}
            {!searching && list.length === 0 && <div style={{ padding: '16px', textAlign: 'center', color: c.fg3, fontSize: 12 }}>No AMIs found</div>}
            {list.map(img => (
              <div key={img.id} onMouseDown={e => { e.preventDefault(); onChange(img.id); setOpen(false); }}
                style={{ padding: '9px 12px', borderBottom: `1px solid ${c.bd}`, cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = c.bg4}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <div style={{ fontSize: 12, color: c.fg, fontWeight: 500 }}>{img.name}</div>
                <div style={{ fontSize: 11, color: c.fg3, marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={{ color: c.info, fontFamily: 'JetBrains Mono, monospace' }}>{img.id}</code>
                  {img.desc && <span>· {img.desc.substring(0, 55)}{img.desc.length > 55 ? '…' : ''}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Module Help Panel --------------------------------------------------------
function ModuleHelpPanel({ serviceType, c }) {
  const help = MODULE_HELP[serviceType] || MODULE_HELP.default;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 12px', background: c.accent + '10', border: `1px solid ${c.accent}30`,
        borderRadius: open ? '8px 8px 0 0' : 8, cursor: 'pointer', color: c.accent, fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', transition: 'all 0.15s',
      }}>
        <span>📦 How to use this module</span>
        <span style={{ fontSize: 12, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {open && (
        <div style={{ background: c.bg2, border: `1px solid ${c.accent}25`, borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 14, fontSize: 12 }}>
          {help.source && (
            <div style={{ marginBottom: 12, background: c.bg, borderRadius: 6, padding: '8px 10px', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: c.info, border: `1px solid ${c.bd}` }}>
              source  = "{help.source}"<br />
              version = "{help.version}"
            </div>
          )}
          <div style={{ color: c.fg2, marginBottom: 10, lineHeight: 1.6 }}>{help.what}</div>
          <div style={{ marginBottom: 10 }}>
            {help.how.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
                <span style={{ color: c.accent, fontWeight: 700 }}>→</span>
                <span style={{ color: c.fg2, lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '7px 10px', background: c.ok + '10', border: `1px solid ${c.ok}25`, borderRadius: 6 }}>
            <span style={{ color: c.ok, fontWeight: 700 }}>💡 Tip: </span>
            <span style={{ color: c.fg2 }}>{help.tip}</span>
          </div>
          <div style={{ marginTop: 10, textAlign: 'right' }}>
            <a href={help.registry || 'https://registry.terraform.io/browse/modules?provider=aws'} target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: c.accent, textDecoration: 'none' }}>
              View on Terraform Registry →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Lifecycle Panel ----------------------------------------------------------
/**
 * Shows a lifecycle.prevent_destroy checkbox for stateful resources.
 * When enabled, Terraform will refuse to destroy the resource during `terraform destroy`
 * or plan replacement, protecting production databases, S3 buckets, etc.
 */
function LifecyclePanel({ config, handleChange, c }) {
  const lc  = config._lifecycle || {};
  const set  = (key, val) => handleChange('_lifecycle', { ...lc, [key]: val });

  return (
    <div style={{
      border: `1px solid ${c.bd}`,
      borderRadius: 10,
      overflow: 'hidden',
      marginTop: 4,
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        background: c.bg2,
        borderBottom: `1px solid ${c.bd}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>🔒 Lifecycle Controls</span>
        <span style={{ fontSize: 10, color: c.fg3, marginLeft: 'auto' }}>Terraform meta-argument</span>
      </div>

      {/* prevent_destroy row */}
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none',
        }}>
          {/* Custom toggle */}
          <div
            onClick={() => set('prevent_destroy', !lc.prevent_destroy)}
            style={{
              width: 36, height: 20, borderRadius: 10,
              background: lc.prevent_destroy ? '#EF4444' : c.bd2,
              cursor: 'pointer', position: 'relative',
              transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 2,
              left: lc.prevent_destroy ? 18 : 2,
              width: 16, height: 16, borderRadius: 8, background: '#fff',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: c.fg }}>
              prevent_destroy
              {lc.prevent_destroy && (
                <span style={{
                  marginLeft: 7, fontSize: 10, fontWeight: 700,
                  color: '#EF4444', background: '#EF444418',
                  padding: '1px 6px', borderRadius: 6,
                }}>ENABLED</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: c.fg3, marginTop: 1 }}>
              Prevents accidental destruction of this resource. Terraform will error
              instead of destroying it.
            </div>
          </div>
        </label>

        {/* create_before_destroy row */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none',
          paddingTop: 8, borderTop: `1px solid ${c.bd}`,
        }}>
          <div
            onClick={() => set('create_before_destroy', !lc.create_before_destroy)}
            style={{
              width: 36, height: 20, borderRadius: 10,
              background: lc.create_before_destroy ? c.accent : c.bd2,
              cursor: 'pointer', position: 'relative',
              transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 2,
              left: lc.create_before_destroy ? 18 : 2,
              width: 16, height: 16, borderRadius: 8, background: '#fff',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: c.fg }}>
              create_before_destroy
            </div>
            <div style={{ fontSize: 11, color: c.fg3, marginTop: 1 }}>
              Create the replacement resource before destroying the original (zero-downtime updates).
            </div>
          </div>
        </label>

        {/* Generated HCL preview */}
        {(lc.prevent_destroy || lc.create_before_destroy) && (
          <pre style={{
            margin: 0, padding: '8px 10px',
            background: c.bg2, border: `1px solid ${c.bd}`,
            borderRadius: 6, fontSize: 11, color: c.fg2,
            fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}>
{`lifecycle {
${lc.prevent_destroy ? '  prevent_destroy       = true\n' : ''
}${lc.create_before_destroy ? '  create_before_destroy = true\n' : ''}}`}
          </pre>
        )}
      </div>
    </div>
  );
}

// --- Empty State --------------------------------------------------------------
function EmptyState({ c }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, color: c.fg3, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 40, opacity: 0.3 }}>◧</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: c.fg2, marginBottom: 6 }}>No Service Selected</div>
        <div style={{ fontSize: 12 }}>Click a service from the left panel to configure it</div>
      </div>
      <div style={{ marginTop: 8, padding: '8px 14px', background: c.accent + '10', border: `1px solid ${c.accent}25`, borderRadius: 8, fontSize: 11, color: c.accent }}>
        ← Browse 50+ AWS services on the left
      </div>
    </div>
  );
}
