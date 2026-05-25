'use strict';
/**
 * /api/learn — Learning & Explanation endpoints
 *
 * POST /api/learn/explain          Explain a HCL block in plain English
 * GET  /api/learn/questions        Interview questions by service types
 * GET  /api/learn/labs             Guided scenario labs list
 * GET  /api/learn/patterns         Architecture pattern library
 * POST /api/learn/labs/progress    Save lab step progress (auth required)
 * GET  /api/learn/labs/progress    Get user's lab progress (auth required)
 */
const router = require('express').Router();
const { optionalAuth, authMiddleware } = require('../middleware/auth');
const db = require('../db/connection');

// ─── HCL EXPLAINER ──────────────────────────────────────────────────────────
const HCL_EXPLANATIONS = {
  provider: { title: 'Provider Block', icon: '🔌', explanation: 'Tells Terraform which cloud platform to use and how to authenticate. The AWS provider reads credentials from environment variables, ~/.aws/credentials, or the config block. Always pin a version constraint (~> x.y) so upgrades don\'t break your configs.', tips: ['Use version = "~> 5.0" to allow patch updates but block major version changes.', 'Never hardcode access_key/secret_key — use environment variables or IAM roles instead.', 'Set the default_tags block here to apply tags to every resource automatically.'] },
  terraform: { title: 'Terraform Settings Block', icon: '⚙️', explanation: 'Configures Terraform itself — the required version, provider sources, and remote state backend. This block must be satisfied before any other block can be parsed.', tips: ['required_version = ">= 1.5" prevents team members from running older broken versions.', 'The required_providers block locks provider source addresses (important for private registries).', 'Move the backend config here to store state remotely in S3 + DynamoDB.'] },
  resource: { title: 'Resource Block', icon: '📦', explanation: 'Declares a real infrastructure object Terraform will create, update, or destroy. The two labels are the resource TYPE (e.g. aws_instance) and your local NAME (e.g. web). The combination "aws_instance.web" is how you reference it elsewhere.', tips: ['Use depends_on only as a last resort — prefer implicit dependencies via references.', 'lifecycle { prevent_destroy = true } protects critical resources like RDS databases.', 'Add tags = { Terraform = "true", Environment = var.env } to every resource for cost tracking.'] },
  variable: { title: 'Variable Block', icon: '🔧', explanation: 'Declares an input parameter so your module or root config can be customised without editing source code. Variables can have types, defaults, descriptions, and validation rules.', tips: ['Always add a description — it appears in the Terraform docs and plan output.', 'Use validation blocks to catch bad input early: validation { condition = ... error_message = ... }.', 'Sensitive variables (passwords, keys) get type = string and sensitive = true so they\'re redacted from logs.'] },
  output: { title: 'Output Block', icon: '📤', explanation: 'Exports a value from your configuration so it can be read by humans (terraform output) or consumed by other modules/workspaces via remote state.', tips: ['Mark outputs that contain secrets with sensitive = true.', 'Child module outputs must be re-exported by the root module if callers need them.', 'Use terraform output -json in CI pipelines to feed values into downstream steps.'] },
  module: { title: 'Module Block', icon: '📚', explanation: 'Calls a reusable Terraform module — either from the local filesystem, the Terraform Registry, or a Git URL. Modules encapsulate a set of resources with a clean input/output interface.', tips: ['Pin the version attribute for Registry modules to avoid surprise upgrades.', 'Pass values through via input variables — never reach into a module\'s internals.', 'Use terragrunt or workspace-level overrides for per-environment module configs.'] },
  data: { title: 'Data Source Block', icon: '🔍', explanation: 'Reads existing infrastructure data from the provider without creating anything. Use data sources to reference resources managed outside this configuration (e.g., look up a shared VPC, find the latest AMI).', tips: ['Data source reads happen during the plan phase — they\'re not cached between runs.', 'Use most_recent = true on AMI data sources so you always get the latest patched image.', 'Reference with data.<type>.<name>.<attribute> — e.g., data.aws_vpc.main.id.'] },
  locals: { title: 'Locals Block', icon: '📝', explanation: 'Defines computed local values you can reuse throughout the configuration. Think of them as constants or derived variables — they reduce repetition and give names to complex expressions.', tips: ['Use locals for computed names: name = "${var.project}-${var.env}-${var.region}".', 'Locals are evaluated lazily — unused locals have no cost.', 'Group related locals into one block for readability; you can have multiple locals blocks.'] },
  lifecycle: { title: 'Lifecycle Meta-Argument', icon: '♻️', explanation: 'Controls how Terraform handles the resource\'s create/update/destroy cycle. Overrides default behaviour for specific scenarios like zero-downtime deployments or protecting production data.', tips: ['create_before_destroy = true is required for resources that can\'t have downtime (e.g., ALB target groups).', 'prevent_destroy = true is a must for RDS instances and S3 buckets in production.', 'ignore_changes = [ami] lets you change the AMI outside Terraform without it being reverted on the next plan.'] },
  backend: { title: 'Backend Configuration', icon: '☁️', explanation: 'Configures where Terraform stores its state file. Local state (the default) is fine for learning but dangerous in teams — use an S3 backend with DynamoDB locking for any shared project.', tips: ['S3 + DynamoDB is the standard AWS backend: bucket for state, DynamoDB table for locking.', 'Enable versioning on the S3 bucket so you can roll back corrupted state.', 'Never commit terraform.tfstate to Git — add it to .gitignore.'] },
};

function detectHclBlockType(hcl) {
  const h = (hcl || '').trim().toLowerCase();
  if (h.startsWith('provider')) return 'provider';
  if (h.startsWith('terraform')) return 'terraform';
  if (h.startsWith('resource')) return 'resource';
  if (h.startsWith('variable')) return 'variable';
  if (h.startsWith('output')) return 'output';
  if (h.startsWith('module')) return 'module';
  if (h.startsWith('data')) return 'data';
  if (h.startsWith('locals')) return 'locals';
  if (/lifecycle\s*\{/.test(h)) return 'lifecycle';
  if (h.startsWith('backend') || /backend\s+"/.test(h)) return 'backend';
  return null;
}

function guessResourceInfo(hcl) {
  const m = hcl.match(/resource\s+"(aws_\w+)"/);
  if (!m) return null;
  const type = m[1];
  const RESOURCE_NOTES = {
    aws_instance: { name: 'EC2 Instance', note: 'Virtual machine on AWS. The ami and instance_type are required. Use user_data for bootstrap scripts.' },
    aws_vpc: { name: 'VPC', note: 'Isolated virtual network. cidr_block defines the IP range. All other networking resources live inside a VPC.' },
    aws_subnet: { name: 'Subnet', note: 'A slice of the VPC IP range in a specific AZ. Public subnets have a route to an Internet Gateway; private ones use a NAT Gateway.' },
    aws_security_group: { name: 'Security Group', note: 'Stateful firewall for EC2, RDS, etc. Ingress/egress rules control what traffic is allowed.' },
    aws_s3_bucket: { name: 'S3 Bucket', note: 'Object storage. Bucket names are globally unique. Always enable versioning and block_public_access for production.' },
    aws_db_instance: { name: 'RDS Instance', note: 'Managed relational database. Set deletion_protection=true and skip_final_snapshot=false in production.' },
    aws_lambda_function: { name: 'Lambda Function', note: 'Serverless function. Needs an IAM execution role and the deployment package (filename or S3).' },
    aws_iam_role: { name: 'IAM Role', note: 'Identity with an assume_role_policy that defines who can assume it, and attached policies for what it can do.' },
    aws_alb: { name: 'Application Load Balancer', note: 'Layer-7 load balancer. Requires subnets in at least 2 AZs and a security group. Pair with aws_alb_listener and aws_alb_target_group.' },
    aws_eks_cluster: { name: 'EKS Cluster', note: 'Managed Kubernetes. Requires an IAM role with AmazonEKSClusterPolicy and at least 2 subnets in different AZs.' },
    aws_dynamodb_table: { name: 'DynamoDB Table', note: 'NoSQL key-value and document store. Define the hash_key (partition key) and optionally range_key (sort key) in the schema.' },
    aws_cloudfront_distribution: { name: 'CloudFront Distribution', note: 'Global CDN. Origins can be S3, ALB, or any HTTP server. SSL/TLS via ACM certificate.' },
    aws_route53_record: { name: 'Route 53 DNS Record', note: 'DNS entry inside a hosted zone. Use alias blocks for pointing to AWS resources like ALBs or CloudFront.' },
    aws_elasticache_cluster: { name: 'ElastiCache Cluster', note: 'Managed Redis or Memcached. Sits inside a VPC; requires a subnet_group_name and security_group_ids.' },
    aws_sqs_queue: { name: 'SQS Queue', note: 'Message queue. Set visibility_timeout_seconds >= Lambda timeout to avoid duplicate processing. FIFO queues add .fifo suffix to name.' },
    aws_sns_topic: { name: 'SNS Topic', note: 'Pub/sub messaging. Add aws_sns_topic_subscription resources to fan out to SQS, Lambda, email, etc.' },
    // ── Networking (v9) ──
    aws_route53_resolver_endpoint: { name: 'Route53 Resolver Endpoint', note: 'Enables DNS resolution between your VPC and on-premises networks. INBOUND receives queries from on-prem; OUTBOUND forwards to on-prem DNS.' },
    aws_route53_resolver_rule: { name: 'Route53 Resolver Rule', note: 'Forwards DNS queries for a specific domain to an on-premises DNS resolver via the resolver endpoint.' },
    aws_route53_traffic_policy: { name: 'Route53 Traffic Policy', note: 'Defines weighted, latency-based, geolocation, or failover routing. Attach to a dns record via a traffic policy instance.' },
    aws_lb_target_group: { name: 'ALB Target Group', note: 'Defines a set of targets (EC2, IP, Lambda) for an ALB/NLB. Required before attaching any load balancer listener.' },
    aws_lb_listener: { name: 'ALB Listener', note: 'Port/protocol rules on an ALB or NLB. Routes traffic to a default target group. Add aws_lb_listener_rule for path-based routing.' },
    aws_lb_listener_rule: { name: 'ALB Listener Rule', note: 'Path-based or host-based routing condition added to an ALB listener. Evaluated in priority order; lowest number wins.' },
    aws_vpc_ipam: { name: 'VPC IPAM', note: 'Centralized IP Address Management service. Tracks and allocates CIDR blocks across accounts and regions. Required parent for IPAM pools.' },
    aws_vpc_ipam_pool: { name: 'VPC IPAM Pool', note: 'Allocates a CIDR block from the parent IPAM scope. Pools can be regional or cross-region and support hierarchical delegation.' },
    // ── Compute (v9) ──
    aws_key_pair: { name: 'EC2 Key Pair', note: 'SSH key pair for EC2 access. Store the private key securely — AWS only stores the public key. Use SSM Session Manager instead where possible.' },
    aws_imagebuilder_image_pipeline: { name: 'EC2 Image Builder Pipeline', note: 'Automates creation of golden AMIs. Define a recipe (base AMI + components), infrastructure config, and optional schedule.' },
    aws_apprunner_service: { name: 'App Runner Service', note: 'Fully managed container platform with no VPC or cluster management needed. Supports auto-scaling to zero. Great for APIs and web apps.' },
    aws_batch_compute_environment: { name: 'AWS Batch Compute Environment', note: 'Manages the EC2 or Fargate fleet that runs batch jobs. Pair with aws_batch_job_queue and aws_batch_job_definition.' },
    aws_lambda_layer_version: { name: 'Lambda Layer', note: 'Shared code or dependencies packaged as a ZIP and attached to Lambda functions. Keeps function packages small and promotes reuse.' },
    aws_lambda_function_url: { name: 'Lambda Function URL', note: 'Provides a direct HTTPS endpoint for a Lambda function — no API Gateway needed. Supports CORS and response streaming.' },
    aws_lambda_event_source_mapping: { name: 'Lambda Event Source Mapping', note: 'Connects Lambda to SQS, Kinesis, or DynamoDB Streams. Set batch_size and bisect_batch_on_function_error for resilience.' },
    // ── Storage (v9) ──
    aws_s3_bucket_policy: { name: 'S3 Bucket Policy', note: 'Resource-based IAM policy attached directly to an S3 bucket. Use to enforce encryption-in-transit (aws:SecureTransport) or cross-account access.' },
    aws_transfer_server: { name: 'AWS Transfer Family', note: 'Managed SFTP/FTPS/FTP server that stores files directly in S3. Supports SERVICE_MANAGED or external identity providers.' },
    aws_backup_vault: { name: 'AWS Backup Vault', note: 'Container for recovery points created by AWS Backup. Separate from the Backup Plan — plans write to vaults. Encrypt with KMS.' },
    aws_storagegateway_gateway: { name: 'Storage Gateway', note: 'Hybrid cloud storage bridge. FILE_S3 presents NFS/SMB shares backed by S3. CACHED/STORED modes extend on-prem storage to AWS.' },
    // ── Database (v9) ──
    aws_db_subnet_group: { name: 'RDS Subnet Group', note: 'Required before creating any RDS or Aurora cluster. Specifies the subnets (in at least 2 AZs) where RDS can place instances.' },
    aws_db_parameter_group: { name: 'RDS Parameter Group', note: 'Engine-level configuration for RDS. Use to tune slow_query_log, max_connections, etc. Changes may require a reboot.' },
    aws_dax_cluster: { name: 'DAX Cluster', note: 'In-memory cache for DynamoDB with microsecond read latency. Drop-in compatible with DynamoDB SDK. Requires an IAM role with DynamoDB access.' },
    aws_neptune_cluster: { name: 'Neptune Cluster', note: 'Fully managed graph database supporting Gremlin and SPARQL. Use for social graphs, fraud detection, and knowledge graphs.' },
    aws_memorydb_cluster: { name: 'MemoryDB for Redis', note: 'Redis-compatible, durable in-memory database with multi-AZ persistence. Unlike ElastiCache, data survives restarts.' },
    aws_keyspaces_table: { name: 'Keyspaces Table (Cassandra)', note: 'Managed Apache Cassandra-compatible database. Fully serverless with on-demand or provisioned capacity.' },
    // ── IAM & Security (v9) ──
    aws_accessanalyzer_analyzer: { name: 'IAM Access Analyzer', note: 'Continuously analyzes resource policies to detect overly permissive access from outside your account or organization.' },
    aws_shield_protection: { name: 'AWS Shield Advanced', note: 'DDoS protection for ALBs, CloudFront, Route 53, and Elastic IPs. Requires Shield Advanced subscription at the account level.' },
    aws_fms_policy: { name: 'Firewall Manager Policy', note: 'Centrally manages WAF, Shield, or Security Group rules across all accounts in an AWS Organization from a designated admin account.' },
    aws_ssoadmin_permission_set: { name: 'IAM Identity Center', note: 'Centralized SSO for AWS accounts and applications. Define permission sets (collections of policies) and assign them to users/groups.' },
    aws_ram_resource_share: { name: 'Resource Access Manager', note: 'Shares AWS resources (subnets, Transit Gateways, RAM pools) across accounts without resource duplication.' },
    aws_directory_service_directory: { name: 'Directory Service (AD)', note: 'Managed Microsoft Active Directory. Use for Windows workloads, RDS SQL Server Windows Auth, and SSO.' },
    aws_cognito_identity_pool: { name: 'Cognito Identity Pool', note: 'Issues temporary AWS credentials to authenticated or unauthenticated users. Pairs with a User Pool for full auth flow.' },
    aws_acmpca_certificate_authority: { name: 'ACM Private CA', note: 'Issues private TLS certificates for internal services. Required for mutual TLS (mTLS) and internal HTTPS without public CA.' },
    aws_verifiedaccess_instance: { name: 'Verified Access', note: 'Zero-trust network access — grants application access based on identity and device posture without a VPN.' },
    // ── Monitoring (v9) ──
    aws_cloudwatch_composite_alarm: { name: 'CloudWatch Composite Alarm', note: 'Combines multiple CloudWatch alarms with AND/OR/NOT logic into a single alarm. Reduces alert noise and creates high-level health indicators.' },
    aws_synthetics_canary: { name: 'CloudWatch Synthetics Canary', note: 'Runs scripted browser or API checks on a schedule to proactively detect endpoint failures before users do.' },
    aws_cloudwatch_metric_stream: { name: 'CloudWatch Metric Stream', note: 'Streams CloudWatch metrics to Kinesis Firehose and then to S3, Datadog, Dynatrace, or Splunk in near real-time.' },
    aws_rum_app_monitor: { name: 'CloudWatch RUM', note: 'Real User Monitoring — captures performance, errors, and HTTP traces from actual browser sessions on your web app.' },
    aws_pipes_pipe: { name: 'EventBridge Pipes', note: 'Point-to-point integration between a source (SQS, DynamoDB, Kinesis) and a target (Lambda, Step Functions, API GW) with optional enrichment.' },
    aws_scheduler_schedule: { name: 'EventBridge Scheduler', note: 'Cron-based or rate-based scheduler that invokes AWS targets. Replaces CloudWatch Events rules for scheduling with better accuracy.' },
    aws_devopsguru_resource_collection: { name: 'DevOps Guru', note: 'AI-powered service that detects operational anomalies and provides recommendations. Monitors CloudFormation stacks or tagged resources.' },
    aws_chatbot_slack_channel_configuration: { name: 'AWS Chatbot', note: 'Sends CloudWatch alarms, Security Hub findings, and other AWS notifications to Slack or Microsoft Teams channels.' },
    // ── Containers (v9) ──
    aws_eks_addon: { name: 'EKS Add-on', note: 'Managed operational software for EKS clusters: vpc-cni, coredns, kube-proxy, aws-ebs-csi-driver. AWS handles version compatibility.' },
    aws_appmesh_mesh: { name: 'App Mesh', note: 'Service mesh providing traffic control, observability, and mutual TLS for microservices. Works with ECS, EKS, and EC2.' },
    aws_ecr_lifecycle_policy: { name: 'ECR Lifecycle Policy', note: 'Automatically removes old or untagged Docker images from an ECR repository to control storage costs.' },
    aws_ecs_capacity_provider: { name: 'ECS Capacity Provider', note: 'Manages EC2 Auto Scaling to meet ECS workload demand. Supports managed scaling and managed termination protection.' },
    aws_eks_identity_provider_config: { name: 'EKS OIDC Identity Provider', note: 'Configures OIDC-based authentication for Kubernetes RBAC, allowing IAM roles to map to K8s ServiceAccounts.' },
    aws_ecrpublic_repository: { name: 'ECR Public Repository', note: 'Hosts publicly accessible Docker images on gallery.ecr.aws. Must be created in us-east-1. No auth required to pull.' },
    // ── CI/CD (v9) ──
    aws_codestarconnections_connection: { name: 'CodeStar Connection', note: 'OAuth connection to GitHub, GitLab, or Bitbucket. Required to use third-party repos as a CodePipeline source.' },
    aws_api_gateway_domain_name: { name: 'API Gateway Custom Domain', note: 'Maps a custom domain (api.example.com) to an API Gateway. Requires an ACM certificate and a Route 53 alias record.' },
    aws_api_gateway_stage: { name: 'API Gateway Stage', note: 'A deployment snapshot of an API (e.g. prod, staging). Controls throttling, logging, X-Ray tracing, and canary deployments.' },
    aws_appconfig_application: { name: 'AppConfig', note: 'Feature flags and runtime configuration with safe deployment strategies (linear, canary). Validates config before rolling out.' },
    aws_cloud9_environment_ec2: { name: 'Cloud9 IDE', note: 'Browser-based IDE on an EC2 instance. Auto-stops when idle to save cost. Useful for onboarding or secure development environments.' },
    aws_codegurureviewer_repository_association: { name: 'CodeGuru Reviewer', note: 'AI-powered code review that finds security vulnerabilities, resource leaks, and best practice violations in PRs.' },
    aws_servicecatalog_portfolio: { name: 'Service Catalog Portfolio', note: 'Curated collection of CloudFormation templates or Terraform configs that teams can self-serve without direct IAM access.' },
    // ── Admin & Ops (v9) ──
    aws_cloudformation_stack: { name: 'CloudFormation Stack', note: 'Deploys an existing CloudFormation template via Terraform. Useful for migrating legacy CFN stacks into a Terraform workflow.' },
    aws_resourcegroups_group: { name: 'Resource Groups', note: 'Groups AWS resources by tag or CloudFormation stack for bulk operations, monitoring, and cost allocation.' },
    aws_ce_anomaly_monitor: { name: 'Cost Anomaly Detection', note: 'ML-powered detection of unexpected AWS cost spikes. Monitors by service, account, cost category, or custom filters.' },
    aws_fis_experiment_template: { name: 'AWS FIS (Chaos Engineering)', note: 'Fault Injection Simulator runs controlled chaos experiments — terminate instances, fail over RDS, drain ECS tasks — with safety guardrails.' },
    aws_drs_replication_configuration_template: { name: 'Elastic Disaster Recovery', note: 'Continuously replicates on-premises or cloud servers to AWS for fast recovery with RPO in seconds and RTO in minutes.' },
    // ── Analytics (v9) ──
    aws_glue_crawler: { name: 'Glue Crawler', note: 'Automatically discovers schema from S3, RDS, or DynamoDB and populates the Glue Data Catalog. Run on a schedule or on-demand.' },
    aws_glue_workflow: { name: 'Glue Workflow', note: 'Orchestrates chains of Glue Jobs and Crawlers. Define triggers (schedule, on-demand, or conditional) to build ETL pipelines.' },
    aws_lakeformation_resource: { name: 'Lake Formation', note: 'Fine-grained permissions for S3 data lakes — column, row, and cell-level access control on top of the Glue Data Catalog.' },
    aws_quicksight_data_set: { name: 'QuickSight Dataset', note: 'Connects QuickSight to a data source and defines transformations. SPICE mode caches data for fast BI dashboard queries.' },
    aws_opensearchserverless_collection: { name: 'OpenSearch Serverless', note: 'Serverless OpenSearch — no cluster sizing or management. Supports SEARCH, TIMESERIES, and VECTORSEARCH collection types.' },
    aws_redshiftserverless_workgroup: { name: 'Redshift Serverless', note: 'On-demand Redshift without managing clusters. Billed per RPU-second. Ideal for intermittent analytics workloads.' },
    // ── App Integration (v9) ──
    aws_ses_configuration_set: { name: 'SES Configuration Set', note: 'Groups SES sending settings and attaches event destinations for bounce, complaint, and delivery tracking.' },
    aws_pinpoint_app: { name: 'Amazon Pinpoint', note: 'Multi-channel messaging platform (push, SMS, email, in-app). Define segments, campaigns, and journeys for user engagement.' },
    aws_appflow_flow: { name: 'AppFlow', note: 'No-code SaaS data integration — moves data between Salesforce, ServiceNow, Slack, etc. and AWS services like S3 and Redshift.' },
    aws_cognito_user_pool_client: { name: 'Cognito User Pool Client', note: 'App-specific configuration in a Cognito User Pool. Defines allowed OAuth flows, callback URLs, and token validity.' },
    aws_cloudwatch_event_api_destination: { name: 'EventBridge API Destination', note: 'Sends EventBridge events to any external HTTPS endpoint with built-in auth (API key, OAuth, Basic). Rate-limited for safety.' },
    // ── Machine Learning (v9) ──
    aws_sagemaker_domain: { name: 'SageMaker Studio Domain', note: 'Central workspace for ML teams with JupyterLab, automated ML, experiments, and pipelines. Supports IAM or SSO auth.' },
    aws_sagemaker_pipeline: { name: 'SageMaker Pipeline', note: 'MLOps pipeline for training, evaluation, and deployment. Steps can include processing, training, tuning, and model registration.' },
    aws_sagemaker_feature_group: { name: 'SageMaker Feature Store', note: 'Centralized repository for ML features. Supports online store (low-latency) and offline store (S3) for training data.' },
    aws_rekognition_collection: { name: 'Rekognition Collection', note: 'Stores face vectors for SearchFacesByImage API. Used for facial recognition, employee badging, and access control.' },
    aws_comprehend_entity_recognizer: { name: 'Comprehend Entity Recognizer', note: 'Custom NLP model trained on your domain data to extract entities (products, people, codes) from unstructured text.' },
    aws_bedrock_custom_model: { name: 'Bedrock Custom Model', note: 'Fine-tunes a foundation model on your data using FINE_TUNING or CONTINUED_PRE_TRAINING. Output model is private to your account.' },
  };
  return RESOURCE_NOTES[type] || { name: type.replace('aws_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), note: `AWS resource of type ${type}.` };
}

router.post('/explain', optionalAuth, (req, res) => {
  const { hcl } = req.body;
  if (!hcl || typeof hcl !== 'string') return res.status(400).json({ error: 'hcl required' });

  const blockType = detectHclBlockType(hcl);
  if (!blockType) {
    return res.json({
      title: 'HCL Block',
      icon: '📄',
      explanation: 'Select a complete block (e.g., a full resource { } or variable { } block) to get an explanation.',
      tips: ['Start selecting from the block keyword (resource, variable, output, module, etc.)', 'Include the opening and closing braces { }'],
      resourceInfo: null,
    });
  }

  const base = HCL_EXPLANATIONS[blockType] || { title: blockType, icon: '📄', explanation: '', tips: [] };
  const resourceInfo = blockType === 'resource' ? guessResourceInfo(hcl) : null;

  res.json({ ...base, resourceInfo });
});

// ─── INTERVIEW QUESTIONS ─────────────────────────────────────────────────────
const INTERVIEW_QUESTIONS = {
  _general: [
    { q: 'What is the difference between terraform plan and terraform apply?', a: 'plan shows what changes will be made (a dry run); apply actually makes those changes. Always review the plan output before applying in production.' },
    { q: 'What is Terraform state and why is it important?', a: 'State is a JSON file that maps your config resources to real infrastructure objects. Without it, Terraform can\'t know what already exists vs what needs to be created.' },
    { q: 'How do you handle secrets in Terraform?', a: 'Never hardcode secrets. Use aws_secretsmanager_secret or aws_ssm_parameter data sources, or inject via environment variables (TF_VAR_name). Mark variables as sensitive = true.' },
    { q: 'What is the difference between a resource and a data source?', a: 'A resource creates/manages infrastructure. A data source only reads existing infrastructure — it\'s read-only and doesn\'t create anything.' },
    { q: 'When would you use terraform import?', a: 'When existing infrastructure was created outside Terraform and you want to bring it under Terraform management without recreating it.' },
    { q: 'What is a Terraform module?', a: 'A reusable, self-contained package of Terraform configurations with defined inputs (variables) and outputs. Modules promote DRY principles and consistency across teams.' },
  ],
  ec2: [
    { q: 'What is user_data in an EC2 instance?', a: 'A script (Bash or PowerShell) that runs once when the instance first boots. Used to install software, configure the OS, or run startup tasks. Changes to user_data recreate the instance.' },
    { q: 'What is the difference between stopping and terminating an EC2 instance?', a: 'Stopping powers off the instance (like turning off a computer) — data on EBS persists. Terminating destroys the instance and deletes root EBS volume unless DeleteOnTermination=false.' },
    { q: 'How do you give an EC2 instance access to S3 without hardcoding credentials?', a: 'Attach an IAM Instance Profile (via iam_instance_profile) with an IAM Role that has the required S3 permissions. The SDK picks up the role credentials automatically from the metadata service.' },
    { q: 'What is an EC2 instance lifecycle hook in Auto Scaling?', a: 'A pause point during scale-out or scale-in that lets you run custom actions (like draining connections or running a config script) before the instance enters or leaves service.' },
  ],
  vpc: [
    { q: 'What is the difference between a public and private subnet?', a: 'A public subnet has a route to an Internet Gateway (0.0.0.0/0 → igw-xxx). A private subnet has no direct internet route; it reaches the internet via a NAT Gateway in a public subnet.' },
    { q: 'What is a NAT Gateway and when do you need one?', a: 'A managed service in a public subnet that lets private subnet resources initiate outbound internet traffic (e.g., apt-get, AWS API calls) while staying unreachable from the internet. Needed whenever private instances require internet access.' },
    { q: 'How many Availability Zones should a production VPC span?', a: 'At least 2 AZs for High Availability. Most production workloads use 3 AZs — one subnet per AZ for each tier (public, private, data).' },
    { q: 'What is a VPC endpoint and why would you use one?', a: 'A private connection from your VPC to AWS services (S3, DynamoDB, etc.) without going through the public internet. Improves security and can reduce NAT Gateway data transfer costs.' },
  ],
  rds: [
    { q: 'What is the purpose of deletion_protection on an RDS instance?', a: 'Prevents accidental deletion. You must disable it first before terraform destroy or a manual deletion can proceed. Always enable in production.' },
    { q: 'What is a Multi-AZ RDS deployment?', a: 'RDS automatically maintains a synchronous standby replica in a different AZ. On failure, AWS fails over automatically (~1–2 min). Enabled via multi_az = true.' },
    { q: 'When would you use a Read Replica vs Multi-AZ?', a: 'Multi-AZ is for high availability (failover). Read Replicas scale read throughput — apps can query replicas to reduce load on the primary. You can promote a Read Replica to standalone if needed.' },
    { q: 'What does skip_final_snapshot = false do for RDS?', a: 'When you destroy the RDS instance, Terraform takes a final snapshot before deletion. Critical for production — allows recovery. Set skip_final_snapshot = true only in dev/test environments.' },
  ],
  s3: [
    { q: 'Why should you enable versioning on an S3 bucket?', a: 'Versioning preserves every version of every object. Lets you recover from accidental deletes or overwrites. Also required when using S3 as a Terraform backend.' },
    { q: 'What is S3 Block Public Access and when should it be disabled?', a: 'A safety setting that prevents public ACLs and policies from taking effect. Should be enabled for all private data. Only disable if you\'re intentionally hosting a public website or assets.' },
    { q: 'How do you encrypt data at rest in S3?', a: 'Use server_side_encryption_configuration with SSE-S3 (AWS managed keys, free) or SSE-KMS (custom KMS key, more control, small cost). Enforce encryption with a bucket policy denying unencrypted uploads.' },
    { q: 'What is an S3 lifecycle rule?', a: 'Automatically transitions objects between storage classes (Standard → IA → Glacier → Deep Archive) or expires them based on age. Essential for cost management on large buckets.' },
  ],
  lambda: [
    { q: 'What is the maximum execution time for a Lambda function?', a: '15 minutes (900 seconds). For longer workloads, use Step Functions, ECS tasks, or Fargate.' },
    { q: 'How does Lambda cold start work?', a: 'On the first invocation (or after inactivity), AWS initialises the execution environment — downloading code, starting the runtime, running the init code. This adds latency. Provisioned Concurrency eliminates cold starts.' },
    { q: 'How do you share code between Lambda functions?', a: 'Lambda Layers — ZIP archives containing libraries or custom runtimes that can be attached to multiple functions. Up to 5 layers per function.' },
    { q: 'What IAM permissions does a Lambda function need?', a: 'A Lambda Execution Role with AWSLambdaBasicExecutionRole (for CloudWatch Logs) plus any service-specific permissions (e.g., s3:GetObject, dynamodb:PutItem). Follow least-privilege.' },
  ],
  iam: [
    { q: 'What is the difference between an IAM User, Role, and Group?', a: 'User: long-term identity for a person or app with permanent credentials. Group: collection of users sharing the same policies. Role: temporary identity assumed by services, EC2, Lambda, etc. — no permanent credentials.' },
    { q: 'What is IAM least privilege?', a: 'Granting only the minimum permissions required to perform a task. Start with no permissions and add only what\'s needed. Avoids blast radius if credentials are compromised.' },
    { q: 'What is an IAM Trust Policy?', a: 'Defines WHO can assume an IAM Role (the principal). An EC2 instance profile\'s trust policy allows ec2.amazonaws.com to assume the role. Separate from permission policies (what the role CAN do).' },
    { q: 'How do Service Control Policies (SCPs) differ from IAM Policies?', a: 'SCPs are AWS Organizations guardrails — they restrict what IAM identities in an account CAN be allowed to do, but don\'t grant permissions themselves. Think of them as ceiling limits.' },
  ],
  eks: [
    { q: 'What IAM roles does an EKS cluster require?', a: 'Two roles: (1) Cluster role with AmazonEKSClusterPolicy — used by the EKS control plane. (2) Node group role with AmazonEKSWorkerNodePolicy, AmazonEC2ContainerRegistryReadOnly, AmazonEKS_CNI_Policy — used by EC2 worker nodes.' },
    { q: 'What is a managed node group in EKS?', a: 'AWS-managed Auto Scaling Group of EC2 instances that act as Kubernetes worker nodes. AWS handles patching and lifecycle events. Simpler than self-managed node groups.' },
    { q: 'How does pod-level IAM work in EKS?', a: 'IRSA (IAM Roles for Service Accounts) — a Kubernetes service account is annotated with an IAM role ARN. Pods using that service account get temporary credentials via the OIDC provider. No node-level permissions needed.' },
  ],
  alb: [
    { q: 'What is the difference between an ALB and NLB?', a: 'ALB (Application) operates at Layer 7 (HTTP/HTTPS) — path-based routing, host-based routing, auth. NLB (Network) operates at Layer 4 (TCP/UDP) — ultra-low latency, static IP, good for non-HTTP workloads.' },
    { q: 'How does ALB health checking work?', a: 'ALB periodically sends HTTP requests to each target\'s health check path (default /). Targets failing X consecutive checks are deregistered. Configure healthy_threshold, unhealthy_threshold, interval, and matcher (expected status codes).' },
    { q: 'What is sticky sessions in ALB?', a: 'Routes all requests from the same client to the same target using a cookie. Useful for stateful apps. Avoid for stateless microservices — breaks load distribution.' },
  ],
};

router.get('/questions', optionalAuth, (req, res) => {
  const services = (req.query.services || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const questions = [...INTERVIEW_QUESTIONS._general];
  const seen = new Set(questions.map(q => q.q));
  for (const svc of services) {
    const svcQs = INTERVIEW_QUESTIONS[svc] || [];
    for (const q of svcQs) {
      if (!seen.has(q.q)) { questions.push(q); seen.add(q.q); }
    }
  }
  res.json({ questions, services, total: questions.length });
});

// ─── SCENARIO LABS ───────────────────────────────────────────────────────────
const LABS = [
  {
    id: 'lab-01', title: 'Deploy a 3-Tier VPC from Scratch', difficulty: 'Beginner',
    duration: '45 min', icon: '🌐', category: 'Networking',
    description: 'Build the foundational networking layer every AWS project needs — a VPC with public and private subnets across multiple AZs.',
    objectives: ['Create a VPC with a /16 CIDR block', 'Add 2 public and 2 private subnets across 2 AZs', 'Attach an Internet Gateway', 'Create a NAT Gateway in a public subnet', 'Configure route tables for public and private subnets'],
    steps: [
      { id: 1, title: 'Create the VPC', description: 'Add an aws_vpc resource. Use CIDR 10.0.0.0/16. Enable DNS hostnames.', requiredServices: ['vpc'], checkHint: 'Look for aws_vpc with cidr_block = "10.0.0.0/16" and enable_dns_hostnames = true' },
      { id: 2, title: 'Add Public Subnets', description: 'Create 2 aws_subnet resources with CIDRs 10.0.1.0/24 and 10.0.2.0/24. Set map_public_ip_on_launch = true.', requiredServices: ['subnet'], checkHint: 'Look for 2+ aws_subnet resources with map_public_ip_on_launch = true' },
      { id: 3, title: 'Add Private Subnets', description: 'Create 2 more aws_subnet resources with CIDRs 10.0.10.0/24 and 10.0.11.0/24. No public IP mapping.', requiredServices: ['subnet'], checkHint: 'Look for 2+ aws_subnet resources without map_public_ip_on_launch' },
      { id: 4, title: 'Attach Internet Gateway', description: 'Add an aws_internet_gateway and aws_route_table for public subnets with a 0.0.0.0/0 route.', requiredServices: ['internet_gateway'], checkHint: 'Look for aws_internet_gateway and aws_route with destination_cidr_block = "0.0.0.0/0"' },
      { id: 5, title: 'Add NAT Gateway', description: 'Create an aws_eip, then an aws_nat_gateway in a public subnet. Add a private route table pointing 0.0.0.0/0 to the NAT.', requiredServices: ['nat_gateway'], checkHint: 'Look for aws_nat_gateway with subnet_id referencing a public subnet' },
    ],
    patternId: 'vpc-3tier',
    services: ['vpc', 'subnet', 'internet_gateway', 'nat_gateway', 'route_table'],
  },
  {
    id: 'lab-02', title: 'Host a Web App: EC2 + ALB + Auto Scaling', difficulty: 'Intermediate',
    duration: '60 min', icon: '⚖️', category: 'Compute',
    description: 'Deploy a highly-available web application behind a load balancer that scales automatically based on load.',
    objectives: ['Create a launch template for EC2 instances', 'Set up an Auto Scaling Group across AZs', 'Create an Application Load Balancer', 'Wire ALB → Target Group → ASG', 'Add a CloudWatch alarm for CPU-based scaling'],
    steps: [
      { id: 1, title: 'Security Groups', description: 'Create 2 security groups: ALB (allow 80/443 from internet) and EC2 (allow 80 from ALB SG only).', requiredServices: ['security_group'], checkHint: 'Look for 2 aws_security_group resources' },
      { id: 2, title: 'Launch Template', description: 'Create an aws_launch_template with your AMI, instance type, and user_data script that installs a web server.', requiredServices: ['ec2'], checkHint: 'Look for aws_launch_template with image_id and instance_type' },
      { id: 3, title: 'Auto Scaling Group', description: 'Create an aws_autoscaling_group referencing the launch template. Set min=2, max=6, desired=2 across 2 private subnets.', requiredServices: ['asg'], checkHint: 'Look for aws_autoscaling_group with min_size=2, max_size=6' },
      { id: 4, title: 'Application Load Balancer', description: 'Create an aws_alb in public subnets, an aws_alb_target_group for port 80, and an aws_alb_listener.', requiredServices: ['alb'], checkHint: 'Look for aws_alb, aws_alb_target_group, and aws_alb_listener resources' },
      { id: 5, title: 'CloudWatch Scaling Policy', description: 'Add a CloudWatch alarm for CPUUtilization > 70% and an autoscaling policy to add instances.', requiredServices: ['cloudwatch_alarm'], checkHint: 'Look for aws_cloudwatch_metric_alarm with metric_name = "CPUUtilization"' },
    ],
    patternId: 'ec2-alb-asg',
    services: ['ec2', 'alb', 'asg', 'security_group', 'cloudwatch_alarm'],
  },
  {
    id: 'lab-03', title: 'Serverless API: API Gateway + Lambda + DynamoDB', difficulty: 'Intermediate',
    duration: '50 min', icon: '⚡', category: 'Serverless',
    description: 'Build a fully serverless CRUD API with no servers to manage and pay-per-request pricing.',
    objectives: ['Create a DynamoDB table with proper key schema', 'Write a Lambda function with an execution role', 'Set up API Gateway REST API', 'Connect Lambda to API Gateway', 'Add CloudWatch logging'],
    steps: [
      { id: 1, title: 'DynamoDB Table', description: 'Create an aws_dynamodb_table with hash_key = "id" (String). Enable point-in-time recovery.', requiredServices: ['dynamodb'], checkHint: 'Look for aws_dynamodb_table with hash_key attribute' },
      { id: 2, title: 'Lambda Execution Role', description: 'Create an aws_iam_role with trust policy for lambda.amazonaws.com. Attach AWSLambdaBasicExecutionRole and custom DynamoDB permissions.', requiredServices: ['iam_role'], checkHint: 'Look for aws_iam_role with assume_role_policy containing lambda.amazonaws.com' },
      { id: 3, title: 'Lambda Function', description: 'Create an aws_lambda_function referencing the role. Set handler, runtime (nodejs20.x or python3.12), and environment variables.', requiredServices: ['lambda'], checkHint: 'Look for aws_lambda_function with role = aws_iam_role.*.arn' },
      { id: 4, title: 'API Gateway', description: 'Create an aws_api_gateway_rest_api, aws_api_gateway_resource, aws_api_gateway_method, and aws_api_gateway_integration (Lambda proxy).', requiredServices: ['api_gateway'], checkHint: 'Look for aws_api_gateway_integration with type = "AWS_PROXY"' },
      { id: 5, title: 'Deploy & Logging', description: 'Add aws_api_gateway_deployment and aws_api_gateway_stage with CloudWatch logging enabled.', requiredServices: ['cloudwatch_log_group'], checkHint: 'Look for aws_api_gateway_stage with access_log_settings' },
    ],
    patternId: 'serverless-api',
    services: ['lambda', 'dynamodb', 'api_gateway', 'iam_role', 'cloudwatch_log_group'],
  },
  {
    id: 'lab-04', title: 'RDS with Read Replica and Secrets Manager', difficulty: 'Intermediate',
    duration: '55 min', icon: '🗄️', category: 'Database',
    description: 'Deploy a production-grade managed database with a read replica, automatic backups, and secure credential management.',
    objectives: ['Create an RDS subnet group across multiple AZs', 'Deploy a MySQL/PostgreSQL RDS instance with best practices', 'Add a Read Replica for read scaling', 'Store DB credentials in Secrets Manager', 'Set up automated backups and deletion protection'],
    steps: [
      { id: 1, title: 'DB Subnet Group', description: 'Create an aws_db_subnet_group spanning at least 2 private subnets in different AZs.', requiredServices: ['rds'], checkHint: 'Look for aws_db_subnet_group with 2+ subnet_ids' },
      { id: 2, title: 'Secrets Manager', description: 'Create an aws_secretsmanager_secret and aws_secretsmanager_secret_version with the DB credentials as JSON.', requiredServices: ['secrets_manager'], checkHint: 'Look for aws_secretsmanager_secret resource' },
      { id: 3, title: 'RDS Primary Instance', description: 'Create aws_db_instance with multi_az=true, deletion_protection=true, backup_retention_period=7, skip_final_snapshot=false.', requiredServices: ['rds'], checkHint: 'Look for aws_db_instance with deletion_protection = true' },
      { id: 4, title: 'Read Replica', description: 'Create a second aws_db_instance with replicate_source_db pointing to the primary instance ARN.', requiredServices: ['rds'], checkHint: 'Look for aws_db_instance with replicate_source_db attribute' },
      { id: 5, title: 'CloudWatch Alarms', description: 'Add alarms for FreeStorageSpace < 10GB and DatabaseConnections > 80% of max.', requiredServices: ['cloudwatch_alarm'], checkHint: 'Look for aws_cloudwatch_metric_alarm with metric_name = "FreeStorageSpace"' },
    ],
    patternId: 'rds-ha',
    services: ['rds', 'secrets_manager', 'security_group', 'cloudwatch_alarm'],
  },
  {
    id: 'lab-05', title: 'EKS Cluster with Managed Node Groups', difficulty: 'Advanced',
    duration: '75 min', icon: '☸️', category: 'Containers',
    description: 'Deploy a production-ready Kubernetes cluster with managed node groups, IRSA, and cluster autoscaler support.',
    objectives: ['Create EKS cluster and node group IAM roles', 'Deploy the EKS cluster with private endpoint', 'Add a managed node group', 'Enable IRSA (IAM Roles for Service Accounts)', 'Configure cluster autoscaler prerequisites'],
    steps: [
      { id: 1, title: 'Cluster IAM Role', description: 'Create an IAM role with AmazonEKSClusterPolicy attached and eks.amazonaws.com as principal.', requiredServices: ['iam_role'], checkHint: 'Look for aws_iam_role with eks.amazonaws.com in trust policy' },
      { id: 2, title: 'Node Group IAM Role', description: 'Create a second IAM role with AmazonEKSWorkerNodePolicy, AmazonEC2ContainerRegistryReadOnly, and AmazonEKS_CNI_Policy.', requiredServices: ['iam_role'], checkHint: 'Look for 2 aws_iam_role_policy_attachment resources for worker node policies' },
      { id: 3, title: 'EKS Cluster', description: 'Create aws_eks_cluster with the cluster role, VPC config with private subnets, and Kubernetes version pinned.', requiredServices: ['eks_cluster'], checkHint: 'Look for aws_eks_cluster with role_arn and vpc_config' },
      { id: 4, title: 'Managed Node Group', description: 'Create aws_eks_node_group with the node role, desired_size=2, min_size=1, max_size=5, and instance_types.', requiredServices: ['eks_cluster'], checkHint: 'Look for aws_eks_node_group with scaling_config block' },
      { id: 5, title: 'OIDC Provider for IRSA', description: 'Create aws_iam_openid_connect_provider using the cluster OIDC issuer URL. This enables pod-level IAM.', requiredServices: ['iam_role'], checkHint: 'Look for aws_iam_openid_connect_provider resource' },
    ],
    patternId: 'eks-cluster',
    services: ['eks_cluster', 'iam_role', 'vpc', 'subnet'],
  },
];

router.get('/labs', optionalAuth, (req, res) => {
  res.json({ labs: LABS, total: LABS.length });
});

// ─── LAB PROGRESS (auth required) ─── MUST be registered before /labs/:labId ─
router.get('/labs/progress', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT lab_id, step_id, completed FROM lab_progress WHERE user_id=$1',
      [req.user.id]
    );
    res.json({ progress: result.rows });
  } catch (e) {
    res.json({ progress: [] });
  }
});

router.get('/labs/:labId', optionalAuth, (req, res) => {
  const lab = LABS.find(l => l.id === req.params.labId);
  if (!lab) return res.status(404).json({ error: 'Lab not found' });
  res.json(lab);
});

router.post('/labs/progress', authMiddleware, async (req, res) => {
  const { lab_id, step_id, completed } = req.body;
  if (!lab_id || !step_id) return res.status(400).json({ error: 'lab_id and step_id required' });
  try {
    await db.query(
      `INSERT INTO lab_progress (user_id, lab_id, step_id, completed, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, lab_id, step_id) DO UPDATE SET completed=$4, updated_at=NOW()`,
      [req.user.id, lab_id, step_id, completed !== false]
    );
    res.json({ saved: true });
  } catch (e) {
    // Table may not exist yet — return success silently
    res.json({ saved: false, reason: 'progress table not yet created' });
  }
});

// ─── ARCHITECTURE PATTERNS ───────────────────────────────────────────────────
const PATTERNS = [
  {
    id: 'vpc-3tier', name: '3-Tier VPC', icon: '🌐',
    category: 'Networking', difficulty: 'Foundational',
    description: 'The standard AWS network layout: public, private, and data tiers across multiple AZs. Foundation for every production workload.',
    whyItWorks: 'Separating public-facing resources (ALB) from compute (EC2/ECS) and data (RDS) into different subnets limits blast radius if any layer is compromised.',
    services: ['vpc', 'subnet', 'internet_gateway', 'nat_gateway', 'route_table'],
    connections: [
      { from: 'internet_gateway', to: 'vpc', label: 'attached to' },
      { from: 'nat_gateway', to: 'internet_gateway', label: 'routes through' },
      { from: 'subnet', to: 'nat_gateway', label: 'private route' },
    ],
  },
  {
    id: 'ec2-alb-asg', name: 'EC2 + ALB + Auto Scaling', icon: '⚖️',
    category: 'Compute', difficulty: 'Intermediate',
    description: 'Horizontally scalable web app with automatic failure recovery and load distribution.',
    whyItWorks: 'The ALB distributes traffic across healthy instances in multiple AZs. The ASG replaces failed instances automatically and scales with demand.',
    services: ['ec2', 'alb', 'asg', 'security_group', 'cloudwatch_alarm'],
    connections: [
      { from: 'alb', to: 'asg', label: 'routes to' },
      { from: 'cloudwatch_alarm', to: 'asg', label: 'triggers scaling' },
    ],
  },
  {
    id: 'serverless-api', name: 'Serverless REST API', icon: '⚡',
    category: 'Serverless', difficulty: 'Intermediate',
    description: 'Pay-per-request API with zero server management. Auto-scales to zero when idle.',
    whyItWorks: 'API Gateway handles HTTP routing and auth. Lambda runs your business logic. DynamoDB scales to zero and handles millions of requests/sec.',
    services: ['lambda', 'dynamodb', 'api_gateway', 'iam_role', 'cloudwatch_log_group'],
    connections: [
      { from: 'api_gateway', to: 'lambda', label: 'invokes' },
      { from: 'lambda', to: 'dynamodb', label: 'reads/writes' },
      { from: 'lambda', to: 'cloudwatch_log_group', label: 'logs to' },
    ],
  },
  {
    id: 'event-pipeline', name: 'Event-Driven Pipeline', icon: '🔄',
    category: 'Messaging', difficulty: 'Intermediate',
    description: 'Decoupled async processing: S3 events trigger SQS, Lambda processes, SNS notifies.',
    whyItWorks: 'SQS decouples producers from consumers, provides retry logic, and absorbs traffic spikes. Lambda scales consumers independently. SNS fans out to multiple channels.',
    services: ['s3', 'sqs', 'lambda', 'sns', 'iam_role'],
    connections: [
      { from: 's3', to: 'sqs', label: 'event notification' },
      { from: 'sqs', to: 'lambda', label: 'triggers' },
      { from: 'lambda', to: 'sns', label: 'publishes to' },
    ],
  },
  {
    id: 'rds-ha', name: 'RDS High Availability', icon: '🗄️',
    category: 'Database', difficulty: 'Intermediate',
    description: 'Production database with automatic failover, read scaling, and encrypted secrets management.',
    whyItWorks: 'Multi-AZ provides synchronous replication and automatic failover. Read Replicas scale read traffic. Secrets Manager rotates credentials automatically.',
    services: ['rds', 'secrets_manager', 'security_group', 'cloudwatch_alarm'],
    connections: [
      { from: 'secrets_manager', to: 'rds', label: 'manages credentials for' },
      { from: 'cloudwatch_alarm', to: 'rds', label: 'monitors' },
    ],
  },
  {
    id: 'eks-cluster', name: 'EKS Production Cluster', icon: '☸️',
    category: 'Containers', difficulty: 'Advanced',
    description: 'Enterprise-grade Kubernetes with IRSA, managed node groups, and autoscaler support.',
    whyItWorks: 'Managed node groups let AWS handle OS patching. IRSA gives pods least-privilege IAM without node-level credentials. VPC CNI assigns real VPC IPs to pods.',
    services: ['eks_cluster', 'iam_role', 'vpc', 'subnet'],
    connections: [
      { from: 'eks_cluster', to: 'vpc', label: 'runs in' },
      { from: 'iam_role', to: 'eks_cluster', label: 'cluster role' },
    ],
  },
  {
    id: 'static-site-cdn', name: 'Static Site + CDN', icon: '🌍',
    category: 'Frontend', difficulty: 'Beginner',
    description: 'S3-hosted static assets served globally through CloudFront with custom domain and HTTPS.',
    whyItWorks: 'CloudFront caches content at 400+ edge locations worldwide. S3 provides cheap, durable storage. ACM provides free HTTPS certificates.',
    services: ['s3', 'cloudfront', 'route53'],
    connections: [
      { from: 'cloudfront', to: 's3', label: 'origin' },
      { from: 'route53', to: 'cloudfront', label: 'alias' },
    ],
  },
  {
    id: 'ci-cd-pipeline', name: 'CI/CD Pipeline', icon: '🚀',
    category: 'DevOps', difficulty: 'Advanced',
    description: 'Fully automated build → test → deploy pipeline with AWS-native tools.',
    whyItWorks: 'CodePipeline orchestrates stages. CodeBuild runs tests and builds Docker images. CodeDeploy handles blue/green deployments with automatic rollback.',
    services: ['codepipeline', 'codebuild', 'codedeploy', 's3', 'iam_role'],
    connections: [
      { from: 'codepipeline', to: 'codebuild', label: 'triggers build' },
      { from: 'codepipeline', to: 'codedeploy', label: 'triggers deploy' },
      { from: 's3', to: 'codepipeline', label: 'artifact store' },
    ],
  },
];

router.get('/patterns', optionalAuth, (req, res) => {
  const { category } = req.query;
  const filtered = category ? PATTERNS.filter(p => p.category === category) : PATTERNS;
  const categories = [...new Set(PATTERNS.map(p => p.category))];
  res.json({ patterns: filtered, categories, total: filtered.length });
});

router.get('/patterns/:id', optionalAuth, (req, res) => {
  const pattern = PATTERNS.find(p => p.id === req.params.id);
  if (!pattern) return res.status(404).json({ error: 'Pattern not found' });
  res.json(pattern);
});

module.exports = router;
