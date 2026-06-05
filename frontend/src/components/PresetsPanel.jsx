import React, { useState } from 'react';

/**
 * Architecture presets — one-click deployment patterns.
 *
 * Each preset defines an array of resources (service_type + default config overrides).
 * Builder.jsx calls onApply(preset.resources) and merges them into the resource list.
 */

// --- Preset definitions -------------------------------------------------------
export const PRESETS = [
  {
    id:       'vpc-public-private-2az',
    category: 'Networking',
    name:     'Public + Private Subnets (2 AZ)',
    icon:     '🌐',
    description: 'VPC with two public and two private subnets across two availability zones. Includes IGW, route tables, and NAT Gateway.',
    why: 'The standard AWS multi-AZ VPC pattern. Required for any production workload with HA requirements. Private subnets protect backend resources; public subnets host load balancers and NAT Gateways.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'vpc',         label: 'Main VPC',         config: { name: 'main', cidr_block: '10.0.0.0/16' } },
      { service_type: 'igw',         label: 'Internet Gateway',  config: { name: 'main-igw' } },
      { service_type: 'subnet',      label: 'Public Subnet AZ-a', config: { name: 'public-az-a', cidr_block: '10.0.1.0/24', availability_zone: 'ap-south-1a', map_public_ip_on_launch: true } },
      { service_type: 'subnet',      label: 'Public Subnet AZ-b', config: { name: 'public-az-b', cidr_block: '10.0.2.0/24', availability_zone: 'ap-south-1b', map_public_ip_on_launch: true } },
      { service_type: 'subnet',      label: 'Private Subnet AZ-a', config: { name: 'private-az-a', cidr_block: '10.0.11.0/24', availability_zone: 'ap-south-1a' } },
      { service_type: 'subnet',      label: 'Private Subnet AZ-b', config: { name: 'private-az-b', cidr_block: '10.0.12.0/24', availability_zone: 'ap-south-1b' } },
      { service_type: 'route_table', label: 'Public Route Table', config: { name: 'public-rt' } },
      { service_type: 'route_table', label: 'Private Route Table', config: { name: 'private-rt' } },
    ],
  },
  {
    id:       'ha-nat-per-az',
    category: 'Networking',
    name:     'HA NAT Gateway (1 per AZ)',
    icon:     '🔀',
    description: 'One NAT Gateway per availability zone with EIPs for high-availability egress from private subnets.',
    why: 'A single NAT Gateway is a single point of failure and a bandwidth bottleneck. One NAT per AZ eliminates cross-AZ traffic costs and survives AZ failures.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'eip',         label: 'EIP for NAT AZ-a', config: { name: 'nat-eip-az-a' } },
      { service_type: 'eip',         label: 'EIP for NAT AZ-b', config: { name: 'nat-eip-az-b' } },
      { service_type: 'nat_gateway', label: 'NAT GW AZ-a',      config: { name: 'nat-az-a', connectivity_type: 'public' } },
      { service_type: 'nat_gateway', label: 'NAT GW AZ-b',      config: { name: 'nat-az-b', connectivity_type: 'public' } },
    ],
  },
  {
    id:       'ec2-alb-private',
    category: 'Compute',
    name:     'EC2 behind ALB in Private Subnet',
    icon:     '🖥',
    description: 'Application Load Balancer in public subnet fronting EC2 instances in private subnets with security groups.',
    why: 'Industry-standard pattern for web applications. ALB provides SSL termination, health checks, and traffic distribution. EC2 in private subnet is unreachable from the internet directly.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'security_group', label: 'ALB Security Group', config: { name: 'alb-sg', description: 'Allow HTTP/HTTPS from internet' } },
      { service_type: 'security_group', label: 'App Security Group',  config: { name: 'app-sg', description: 'Allow traffic from ALB only' } },
      { service_type: 'alb',            label: 'Application LB',      config: { name: 'app-alb', internal: false, load_balancer_type: 'application' } },
      { service_type: 'ec2',            label: 'App Server',          config: { name: 'app-server', instance_type: 't3.micro' } },
    ],
  },
  {
    id:       'rds-private-multi-az',
    category: 'Database',
    name:     'RDS Multi-AZ (Private)',
    icon:     '🗄',
    description: 'RDS instance with Multi-AZ, encryption at rest, automated backups, and DB subnet group in private subnets.',
    why: 'Multi-AZ provides automatic failover and eliminates database downtime for maintenance. Encrypted storage satisfies SOC-2 and PCI-DSS requirements. Private subnets prevent direct internet access.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'security_group', label: 'DB Security Group', config: { name: 'db-sg', description: 'Allow DB port from app tier only' } },
      { service_type: 'rds',            label: 'RDS Instance',      config: { name: 'app-db', engine: 'postgres', instance_class: 'db.t3.micro', multi_az: true, storage_encrypted: true, backup_retention_period: 7, deletion_protection: true } },
    ],
  },
  {
    id:       'serverless-api',
    category: 'Serverless',
    name:     'Serverless API (Lambda + API GW)',
    icon:     'λ',
    description: 'Lambda functions behind API Gateway with IAM role, CloudWatch log group, and S3 bucket for deployment artifacts.',
    why: 'Serverless eliminates server management, scales to zero automatically, and has very low cost for sporadic traffic. API Gateway provides throttling, auth, and CORS.',
    complexity: 'Beginner',
    resources: [
      { service_type: 'iam_role',   label: 'Lambda Execution Role', config: { name: 'lambda-exec-role' } },
      { service_type: 's3',         label: 'Artifacts Bucket',      config: { name: 'lambda-artifacts', versioning: true } },
      { service_type: 'lambda',     label: 'API Handler',           config: { name: 'api-handler', runtime: 'python3.12', memory_size: 256, timeout: 30 } },
    ],
  },
  {
    id:       'eks-cluster',
    category: 'Container',
    name:     'EKS Cluster (Private Nodes)',
    icon:     '☸',
    description: 'EKS cluster with managed node group in private subnets, cluster autoscaler IAM role, and KMS encryption.',
    why: 'Managed Kubernetes for containerized workloads. Private node group prevents direct exposure. KMS envelope encryption protects Kubernetes secrets at rest.',
    complexity: 'Advanced',
    resources: [
      { service_type: 'iam_role',   label: 'EKS Cluster Role',    config: { name: 'eks-cluster-role' } },
      { service_type: 'iam_role',   label: 'EKS Node Group Role', config: { name: 'eks-node-role' } },
      { service_type: 'kms',        label: 'EKS Secrets Key',     config: { name: 'eks-secrets-key', enable_key_rotation: true } },
      { service_type: 'security_group', label: 'EKS Cluster SG', config: { name: 'eks-cluster-sg' } },
      { service_type: 'eks',        label: 'EKS Cluster',         config: { name: 'app-cluster', kubernetes_version: '1.29' } },
    ],
  },
  {
    id:       's3-static-cloudfront',
    category: 'Storage',
    name:     'S3 Static Site + CloudFront',
    icon:     '🪣',
    description: 'Private S3 bucket for static assets with CloudFront distribution, OAC, and custom error pages.',
    why: 'S3 + CloudFront is the standard pattern for serving static websites globally with low latency, high availability, and minimal cost. Private S3 bucket with OAC is the modern secure approach (no public bucket ACLs).',
    complexity: 'Beginner',
    resources: [
      { service_type: 's3',  label: 'Static Assets Bucket', config: { name: 'static-site', versioning: true, server_side_encryption_configuration: 'AES256' } },
      { service_type: 'kms', label: 'S3 KMS Key',           config: { name: 's3-kms-key', enable_key_rotation: true } },
    ],
  },
  {
    id:       'elasticache-redis',
    category: 'Caching',
    name:     'ElastiCache Redis (Cluster Mode)',
    icon:     '⚡',
    description: 'ElastiCache Redis replication group in private subnets with encryption at rest and in transit.',
    why: 'In-memory caching reduces database load dramatically. Encryption at rest and in transit is required for PCI-DSS compliance. Private subnets prevent direct internet access to the cache.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'security_group', label: 'Redis SG', config: { name: 'redis-sg', description: 'Allow Redis port from app tier' } },
      { service_type: 'elasticache',    label: 'Redis Cluster', config: { name: 'app-cache', engine: 'redis', node_type: 'cache.t3.micro', num_cache_clusters: 2, at_rest_encryption_enabled: true, transit_encryption_enabled: true } },
    ],
  },

  // ── v9 presets ────────────────────────────────────────────────────────────

  {
    id:       'alb-full-stack',
    category: 'Networking',
    name:     'ALB with Target Group + Listener',
    icon:     '🔀',
    description: 'Complete ALB setup with target group, HTTPS listener, listener rule, and ACM certificate.',
    why: 'An ALB alone is not functional — you need a target group (where to send traffic), a listener (which port/protocol), and rules (routing conditions). This preset wires all three together.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'alb',              label: 'Application LB',    config: { name: 'app-alb', internal: false, load_balancer_type: 'application' } },
      { service_type: 'alb_target_group', label: 'App Target Group',  config: { name: 'app-tg', port: '80', protocol: 'HTTP', target_type: 'ip' } },
      { service_type: 'alb_listener',     label: 'HTTPS Listener',    config: { name: 'https-listener', port: '443', protocol: 'HTTPS', ssl_policy: 'ELBSecurityPolicy-TLS13-1-2-2021-06' } },
      { service_type: 'alb_listener_rule',label: 'API Path Rule',     config: { name: 'api-rule', priority: '100', path_pattern: '/api/*' } },
    ],
  },

  {
    id:       'rds-full-stack',
    category: 'Database',
    name:     'RDS with Subnet Group + Parameter Group',
    icon:     '🗄',
    description: 'Production-ready RDS setup including subnet group across 2 AZs and a tuned parameter group.',
    why: 'aws_db_instance fails without a subnet group. Parameter groups let you tune slow_query_log, max_connections and other engine settings without modifying the DB. Both are required for production.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'db_subnet_group',    label: 'DB Subnet Group',    config: { name: 'app-db-subnets', description: 'RDS subnet group' } },
      { service_type: 'db_parameter_group', label: 'DB Parameter Group', config: { name: 'app-db-params', family: 'mysql8.0' } },
      { service_type: 'rds',                label: 'RDS Instance',       config: { name: 'app-db', engine: 'mysql', instance_class: 'db.t3.micro', storage_encrypted: true, deletion_protection: true } },
    ],
  },

  {
    id:       'serverless-event-driven',
    category: 'Serverless',
    name:     'Event-Driven Pipeline (SQS → Lambda → DLQ)',
    icon:     '⚡',
    description: 'SQS queue triggers Lambda via event source mapping with a Dead Letter Queue capturing failures.',
    why: 'Without a DLQ, failed messages are silently dropped after the max retry count. The event source mapping (ESM) polls SQS and auto-retries with bisect-on-error. This is the minimal resilient serverless pipeline.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'sqs_queue',                  label: 'Source Queue',    config: { name: 'event-queue' } },
      { service_type: 'sqs_queue_redrive_policy',   label: 'Dead Letter Queue', config: { name: 'event-dlq', max_receive_count: '3' } },
      { service_type: 'lambda',                     label: 'Event Processor', config: { name: 'event-processor', runtime: 'python3.12', memory_size: '256', timeout: '30' } },
      { service_type: 'lambda_event_source_mapping',label: 'SQS → Lambda ESM', config: { name: 'sqs-esm', batch_size: '10', bisect_on_error: 'true' } },
    ],
  },

  {
    id:       'eks-production',
    category: 'Container',
    name:     'EKS Production Stack',
    icon:     '☸',
    description: 'EKS cluster with essential add-ons (VPC CNI, CoreDNS, EBS CSI), OIDC identity provider, and ECR lifecycle policy.',
    why: 'A bare EKS cluster needs add-ons for DNS, networking, and storage before workloads can run. OIDC enables IAM Roles for Service Accounts (IRSA) — the secure way for pods to access AWS APIs.',
    complexity: 'Advanced',
    resources: [
      { service_type: 'eks',                          label: 'EKS Cluster',         config: { name: 'prod-cluster', kubernetes_version: '1.30' } },
      { service_type: 'eks_addon',                    label: 'VPC CNI Add-on',      config: { name: 'vpc-cni-addon', addon_name: 'vpc-cni' } },
      { service_type: 'eks_addon',                    label: 'CoreDNS Add-on',      config: { name: 'coredns-addon', addon_name: 'coredns' } },
      { service_type: 'eks_addon',                    label: 'EBS CSI Add-on',      config: { name: 'ebs-csi-addon', addon_name: 'aws-ebs-csi-driver' } },
      { service_type: 'eks_identity_provider_config', label: 'OIDC Provider',       config: { name: 'eks-oidc', identity_provider_name: 'eks-oidc' } },
      { service_type: 'ecr_repository',               label: 'App ECR Repo',        config: { name: 'app-repo' } },
      { service_type: 'ecr_lifecycle_policy',         label: 'ECR Lifecycle Policy',config: { name: 'app-repo-lifecycle', max_image_count: '30', untagged_expire_days: '7' } },
    ],
  },

  {
    id:       'cognito-auth-stack',
    category: 'Security',
    name:     'Cognito Full Auth Stack',
    icon:     '🔐',
    description: 'Cognito User Pool + App Client + Identity Pool for full federated authentication with IAM credentials.',
    why: 'User Pool handles sign-up/sign-in. The App Client is the per-application config with OAuth flows and callback URLs. Identity Pool issues temporary IAM credentials to authenticated users for direct AWS API access.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'cognito_user_pool',        label: 'User Pool',         config: { name: 'app-users' } },
      { service_type: 'cognito_user_pool_client', label: 'Web App Client',    config: { name: 'web-client', callback_urls: 'https://app.example.com/callback', generate_secret: 'false' } },
      { service_type: 'cognito_identity_pool',    label: 'Identity Pool',     config: { name: 'app_identity_pool', allow_unauthenticated: 'false' } },
    ],
  },

  {
    id:       'observability-stack',
    category: 'Monitoring',
    name:     'Full Observability Stack',
    icon:     '📊',
    description: 'Composite alarm, Synthetics canary, RUM monitor, Chatbot Slack alerts, and Cost Anomaly Detection.',
    why: 'A mature observability setup needs: synthetic checks (catch failures before users do), RUM (real-user experience), composite alarms (reduce noise), and Slack/Teams integration for ops on-call.',
    complexity: 'Advanced',
    resources: [
      { service_type: 'synthetics_canary',             label: 'Endpoint Canary',      config: { name: 'app-canary', schedule_expression: 'rate(5 minutes)' } },
      { service_type: 'rum_app_monitor',               label: 'RUM Monitor',          config: { name: 'app-rum', domain: 'app.example.com', session_sample_rate: '0.1' } },
      { service_type: 'cloudwatch_composite_alarm',    label: 'Health Composite Alarm', config: { name: 'app-health-alarm', alarm_rule: 'ALARM("canary-alarm") OR ALARM("error-rate-alarm")' } },
      { service_type: 'chatbot_slack_channel_configuration', label: 'Slack Alerts', config: { name: 'ops-alerts', config_name: 'ops-slack-alerts' } },
      { service_type: 'ce_anomaly_monitor',            label: 'Cost Anomaly Monitor', config: { name: 'cost-monitor', threshold_amount: '100' } },
    ],
  },

  {
    id:       'data-lake',
    category: 'Analytics',
    name:     'Data Lake (S3 + Glue + Lake Formation)',
    icon:     '🏞',
    description: 'S3 data lake with Glue Crawler for schema discovery, Glue Workflow for ETL orchestration, and Lake Formation for fine-grained access control.',
    why: 'A proper data lake needs automatic schema discovery (Crawler), orchestrated processing (Workflow), and column/row-level permissions (Lake Formation). Without these, data access is uncontrolled and ETL is manual.',
    complexity: 'Advanced',
    resources: [
      { service_type: 's3',                  label: 'Data Lake Bucket',  config: { name: 'data-lake', versioning: true } },
      { service_type: 'glue_catalog_database',label: 'Glue Database',   config: { name: 'data_lake_db' } },
      { service_type: 'glue_crawler',        label: 'Schema Crawler',    config: { name: 'data-crawler', s3_path: 's3://data-lake/raw/' } },
      { service_type: 'glue_workflow',       label: 'ETL Workflow',      config: { name: 'etl-pipeline', max_concurrent_runs: '1' } },
      { service_type: 'lakeformation_resource', label: 'Lake Formation', config: { name: 'lake-permissions' } },
    ],
  },

  {
    id:       'ml-platform',
    category: 'ML / AI',
    name:     'ML Platform (SageMaker Studio + Feature Store)',
    icon:     '🤖',
    description: 'SageMaker Studio domain, ML pipeline, and Feature Store for a complete MLOps platform.',
    why: 'ML teams need a shared Studio workspace for experimentation, a Feature Store for centralised training data, and automated Pipelines for reproducible training. This is the minimal MLOps stack.',
    complexity: 'Advanced',
    resources: [
      { service_type: 'sagemaker_domain',        label: 'Studio Domain',    config: { name: 'ml-studio', auth_mode: 'IAM', instance_type: 'ml.t3.medium' } },
      { service_type: 'sagemaker_feature_group', label: 'Feature Store',    config: { name: 'customer-features', record_identifier: 'customer_id', event_time_feature: 'event_time', enable_online: 'true' } },
      { service_type: 'sagemaker_pipeline',      label: 'Training Pipeline',config: { name: 'training-pipeline', instance_type: 'ml.m5.large' } },
    ],
  },

  {
    id:       'devsecops-stack',
    category: 'Security',
    name:     'DevSecOps Foundation',
    icon:     '🛡',
    description: 'IAM Access Analyzer, S3 bucket policy enforcing TLS, Shield protection, and Cost Anomaly Detection.',
    why: 'DevSecOps automation: Access Analyzer continuously audits policies for external access, S3 bucket policy enforces encryption-in-transit, Shield protects production endpoints, anomaly detection catches billing surprises.',
    complexity: 'Intermediate',
    resources: [
      { service_type: 'iam_access_analyzer', label: 'Access Analyzer', config: { name: 'account-analyzer', type: 'ACCOUNT' } },
      { service_type: 's3_bucket_policy',    label: 'S3 TLS Policy',   config: { name: 'tls-policy', effect: 'Deny', condition_key: 'aws:SecureTransport', condition_value: 'false' } },
      { service_type: 'shield_protection',   label: 'Shield ALB',      config: { name: 'alb-shield' } },
      { service_type: 'ce_anomaly_monitor',  label: 'Cost Anomaly',    config: { name: 'cost-monitor', threshold_amount: '100', alert_email: 'ops@example.com' } },
    ],
  },

  {
    id:       'disaster-recovery',
    category: 'Admin & Ops',
    name:     'Disaster Recovery (DRS + Backup Vault)',
    icon:     '🔄',
    description: 'AWS Elastic Disaster Recovery replication template and Backup Vault for comprehensive DR coverage.',
    why: 'DRS continuously replicates on-prem servers with RPO in seconds. Backup Vault provides point-in-time recovery for AWS-native resources. Together they cover both migration and native-AWS DR scenarios.',
    complexity: 'Advanced',
    resources: [
      { service_type: 'backup_vault',                           label: 'Backup Vault', config: { name: 'prod-backup-vault' } },
      { service_type: 'drs_replication_configuration_template', label: 'DRS Config',   config: { name: 'drs-config', replication_server_instance_type: 't3.small' } },
    ],
  },
];

const CATEGORIES = [...new Set(PRESETS.map(p => p.category))];
const COMPLEXITY_COLOR = {
  Beginner:     'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  Intermediate: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  Advanced:     'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

// --- Component ----------------------------------------------------------------
/**
 * Props:
 *   onApply — (presetResources) => void  (called with the resource definitions to add)
 *   onClose — () => void
 */
export default function PresetsPanel({ onApply, onClose }) {
  const [activeCategory, setActiveCategory] = useState('All');
  const [expanded, setExpanded] = useState(null); // preset id with "why" expanded

  const visible = activeCategory === 'All'
    ? PRESETS
    : PRESETS.filter(p => p.category === activeCategory);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
      {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        	<div>
          <h2 className="text-sm font-bold text-gray-900 dark:text-white">Architecture Presets</h2>
          <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5">One-click best-practice patterns</p>
        </div>

        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">×</button>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 px-3 py-2 flex-wrap border-b border-gray-100 dark:border-gray-800">
        {['All', ...CATEGORIES].map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>


      {/* Preset list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {visible.map(preset => (
          <div key={preset.id}
            className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-blue-300 dark:hover:border-blue-600 transition-colors">

            {/* Preset header */}
            <div className="flex items-start gap-3 p-3">
              <span className="text-2xl flex-shrink-0 mt-0.5">{preset.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{preset.name}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${COMPLEXITY_COLOR[preset.complexity]}`}>
                    {preset.complexity}
                  </span>
                  <span className="text-[10px] text-gray-600 dark:text-gray-400">{preset.category}</span>

                </div>
                <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5 leading-relaxed">{preset.description}</p>


                {/* Resource count */}
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-gray-600">{preset.resources.length} resources</span>

                  <button
                    onClick={() => setExpanded(expanded === preset.id ? null : preset.id)}
                    className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400"
                  >
                    {expanded === preset.id ? '▲ Hide rationale' : '▼ Why this default?'}
                  </button>
                </div>

                {/* Why tooltip */}
                {expanded === preset.id && (
                  <div className="mt-2 p-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
                    <p className="text-xs text-blue-900 dark:text-blue-100 leading-relaxed">{preset.why}</p>

                  </div>
                )}

                {/* Resource list preview */}
                <div className="flex flex-wrap gap-1 mt-2">
                  {preset.resources.map((r, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-mono">
                      {r.service_type}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Apply button */}
            <div className="px-3 pb-3">
              <button
                onClick={() => { onApply(preset.resources); onClose?.(); }}
                className="w-full text-xs py-1.5 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors"
              >
                Apply Preset → {preset.name}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
