import React, { useState, useMemo } from 'react';

// --- Resource knowledge base --------------------------------------------------
const RESOURCE_KB = {
  aws_vpc: {
    icon: '🌐', color: '#6366f1', label: 'Virtual Private Cloud (VPC)',
    what: 'An isolated private network in AWS — your own section of the cloud with a defined IP address range.',
    why: 'Everything else (EC2, RDS, subnets, load balancers) must live inside a VPC. It defines network boundaries and security zones.',
    impact: 'A private network is provisioned. Nothing runs inside it yet — add subnets, an IGW, and route tables next.',
    flow: '① Create VPC → ② Add subnets → ③ Attach Internet Gateway → ④ Configure route tables → ⑤ Launch resources',
    connections: ['aws_subnet', 'aws_internet_gateway', 'aws_security_group', 'aws_route_table'],
  },
  aws_subnet: {
    icon: '🔷', color: '#0ea5e9', label: 'Subnet',
    what: 'A slice of the VPC\'s IP range tied to one Availability Zone (data center).',
    why: 'Subnets segment your network into zones. Public subnets face the internet; private subnets are internal only.',
    impact: 'A network segment is ready inside the VPC. EC2 instances, RDS databases, and Lambda functions can now be placed here.',
    connections: ['aws_vpc', 'aws_route_table', 'aws_instance', 'aws_nat_gateway'],
  },
  aws_internet_gateway: {
    icon: '🌍', color: '#94a3b8', label: 'Internet Gateway (IGW)',
    what: 'The connection bridge between your VPC and the public internet.',
    why: 'Without an IGW, nothing inside the VPC can receive traffic from or send traffic to the internet.',
    impact: 'Your VPC now has an internet connection point. You still need a route table rule: 0.0.0.0/0 → this IGW.',
    connections: ['aws_vpc', 'aws_route_table'],
  },
  aws_route_table: {
    icon: '📋', color: '#a78bfa', label: 'Route Table',
    what: 'A set of rules (routes) that decide where network traffic from subnets is directed.',
    why: 'Without a route table, subnets can only talk to each other inside the VPC. Routes unlock internet, NAT, and peering connectivity.',
    impact: 'Routing rules are configured but no subnet uses them yet. Associate subnets via aws_route_table_association.',
    connections: ['aws_subnet', 'aws_internet_gateway', 'aws_nat_gateway'],
  },
  aws_route_table_association: {
    icon: '🔗', color: '#64748b', label: 'Route Table Association',
    what: 'Links a subnet to a route table so that subnet\'s traffic follows those routing rules.',
    why: 'A route table only applies to subnets explicitly associated with it. Without this, subnets fall back to the main (default) route table.',
    impact: 'The subnet now routes traffic per the route table. If the route table has an IGW route, the subnet becomes public-facing.',
    connections: ['aws_subnet', 'aws_route_table'],
  },
  aws_nat_gateway: {
    icon: '🔀', color: '#84cc16', label: 'NAT Gateway',
    what: 'Allows instances in private subnets to initiate outbound internet requests while remaining unreachable from the internet.',
    why: 'Private EC2 instances still need to download packages, call AWS APIs, etc. NAT Gateway enables this without exposing them.',
    impact: 'Private instances can now reach the internet. Costs ~$32/month + $0.045/GB data transfer.',
    connections: ['aws_subnet', 'aws_eip', 'aws_route_table'],
  },
  aws_eip: {
    icon: '📍', color: '#fb923c', label: 'Elastic IP Address',
    what: 'A static public IP address that you own and can attach to AWS resources.',
    why: 'NAT Gateways and EC2 instances need a stable public IP that doesn\'t change on restart.',
    impact: 'A fixed public IP is reserved. Costs ~$4/month when attached, or ~$7/month when unused (idle charges apply).',
    connections: ['aws_nat_gateway', 'aws_instance'],
  },
  aws_security_group: {
    icon: '🛡', color: '#f59e0b', label: 'Security Group (Firewall)',
    what: 'A stateful virtual firewall that controls allowed inbound and outbound network traffic.',
    why: 'AWS blocks all inbound traffic by default. Security groups explicitly allow specific ports and IP ranges.',
    impact: 'A firewall is ready to attach to instances. Ingress rules open ports; egress rules control outbound traffic.',
    connections: ['aws_instance', 'aws_db_instance', 'aws_alb', 'aws_lambda_function'],
  },
  aws_instance: {
    icon: '🖥', color: '#10b981', label: 'EC2 Instance (Virtual Machine)',
    what: 'A virtual machine running Linux or Windows in AWS that you can SSH into and run software on.',
    why: 'Used to host web servers, APIs, backend services, machine learning workloads, or any custom application.',
    impact: 'A VM is running and you\'re charged per hour. SSH into it using your key pair and start deploying your application.',
    flow: 'Launch → SSH via key pair → Install software → Deploy app → Add to load balancer',
    connections: ['aws_subnet', 'aws_security_group', 'aws_iam_role', 'aws_eip'],
  },
  aws_db_instance: {
    icon: '🗄', color: '#8b5cf6', label: 'RDS Database Instance',
    what: 'A managed relational database server (MySQL, PostgreSQL, MariaDB, etc.) hosted and maintained by AWS.',
    why: 'AWS handles backups, patching, monitoring, and Multi-AZ failover — you focus on your data schema and queries.',
    impact: 'A running database is provisioned. Connect using the endpoint output. Billing starts immediately (hourly).',
    connections: ['aws_db_subnet_group', 'aws_security_group', 'aws_kms_key'],
  },
  aws_s3_bucket: {
    icon: '🪣', color: '#f97316', label: 'S3 Bucket (Object Storage)',
    what: 'Infinitely scalable file/object storage — for images, videos, backups, logs, static websites, and data lakes.',
    why: 'S3 provides 99.999999999% (11 nines) durability, scales automatically, and costs ~$0.023/GB/month.',
    impact: 'A private storage bucket is created. Upload objects via the AWS console, CLI, or SDK.',
    connections: ['aws_s3_bucket_versioning', 'aws_s3_bucket_public_access_block', 'aws_cloudfront_distribution'],
  },
  aws_lambda_function: {
    icon: 'λ', color: '#ec4899', label: 'Lambda Function (Serverless)',
    what: 'Run code in response to events without provisioning or managing servers. Pay only when your code runs.',
    why: 'Perfect for event-driven tasks, APIs via API Gateway, data processing, and scheduled jobs. Zero idle cost.',
    impact: 'The function is deployed and ready. First 1 million requests/month are free. Trigger via events or direct invocation.',
    connections: ['aws_iam_role', 'aws_cloudwatch_log_group', 'aws_sqs_queue', 'aws_api_gateway_rest_api'],
  },
  aws_alb: {
    icon: '⚖', color: '#14b8a6', label: 'Application Load Balancer (ALB)',
    what: 'Distributes incoming HTTP/HTTPS traffic across multiple backend targets (EC2, Lambda, containers).',
    why: 'Provides high availability, SSL/TLS termination, health checks, and path/host-based routing.',
    impact: 'A load balancer endpoint is created. Add aws_alb_listener and aws_alb_target_group to route traffic to backends.',
    connections: ['aws_subnet', 'aws_security_group', 'aws_alb_listener', 'aws_alb_target_group'],
  },
  aws_iam_role: {
    icon: '👤', color: '#f43f5e', label: 'IAM Role',
    what: 'An AWS identity with specific permissions that services (EC2, Lambda, ECS, etc.) can temporarily assume.',
    why: 'Eliminates the need to hardcode credentials. Services assume the role and get temporary, scoped permissions automatically.',
    impact: 'The role exists but grants nothing until policies are attached. Add aws_iam_role_policy_attachment to assign permissions.',
    connections: ['aws_iam_policy', 'aws_instance', 'aws_lambda_function', 'aws_iam_instance_profile'],
  },
  aws_kms_key: {
    icon: '🔑', color: '#fbbf24', label: 'KMS Encryption Key',
    what: 'A managed cryptographic key for encrypting AWS resources — RDS databases, S3 buckets, EBS volumes, etc.',
    why: 'Customer-managed keys give you full control over encryption, key rotation, and who can decrypt your data.',
    impact: 'An encryption key is created (~$1/month/key + usage fees). Reference it via kms_key_id in other resources.',
    connections: ['aws_db_instance', 's3_bucket', 'aws_ebs_volume', 'aws_sns_topic'],
  },
  aws_eks_cluster: {
    icon: '☸', color: '#3b82f6', label: 'EKS Kubernetes Cluster',
    what: 'Managed Kubernetes control plane — run containerised workloads at scale without managing the control plane.',
    why: 'AWS manages etcd, API server, and scheduler upgrades. You manage worker nodes and workload deployments.',
    impact: 'Control plane is running (~$73/month). Add node groups (aws_eks_node_group) and deploy workloads with kubectl.',
    connections: ['aws_subnet', 'aws_security_group', 'aws_iam_role', 'aws_eks_node_group'],
  },
  aws_cloudfront_distribution: {
    icon: '🚀', color: '#7c3aed', label: 'CloudFront Distribution (CDN)',
    what: 'Global Content Delivery Network that caches and serves your content from 400+ edge locations worldwide.',
    why: 'Reduces latency for users globally, shields your origin from traffic spikes, and provides free HTTPS via ACM.',
    impact: 'Content is served from the nearest edge location. Origin (S3/ALB) receives far less direct traffic.',
    connections: ['aws_s3_bucket', 'aws_alb', 'aws_acm_certificate'],
  },
  aws_elasticache_cluster: {
    icon: '⚡', color: '#d946ef', label: 'ElastiCache (Redis / Memcached)',
    what: 'Managed in-memory caching — much faster than querying a database for the same data repeatedly.',
    why: 'Caching hot data in memory reduces database load and can cut response times from milliseconds to microseconds.',
    impact: 'An in-memory cache cluster is running. Connect from your application using the cluster endpoint attribute.',
    connections: ['aws_subnet', 'aws_security_group', 'aws_elasticache_subnet_group'],
  },
  aws_sns_topic: {
    icon: '📣', color: '#e11d48', label: 'SNS Topic (Pub/Sub Messaging)',
    what: 'A publish-subscribe messaging channel. Publishers send messages; all subscribers receive them.',
    why: 'Decouples services — a payment service can publish an event without knowing who handles it downstream.',
    impact: 'The topic is created. Add aws_sns_topic_subscription resources to fan out to SQS, Lambda, email, HTTPS endpoints.',
    connections: ['aws_sqs_queue', 'aws_lambda_function'],
  },
  aws_sqs_queue: {
    icon: '📨', color: '#7c3aed', label: 'SQS Queue (Message Queue)',
    what: 'A managed message queue for decoupling producers and consumers. Messages persist until consumed.',
    why: 'Smooths traffic spikes (queue buffers bursts), enables async processing, and prevents data loss if consumers are slow.',
    impact: 'The queue is ready to receive messages. Consumers poll it via the queue URL. First 1M requests/month are free.',
    connections: ['aws_lambda_function', 'aws_sns_topic'],
  },
};

// --- Field knowledge base -----------------------------------------------------
const FIELD_KB = {
  // EC2
  ami: {
    what: 'Amazon Machine Image — the operating system + software snapshot your instance boots from',
    why: 'Every EC2 instance needs an OS. Think of this as choosing what operating system to install on the VM.',
    tip: 'Use a data source (data "aws_ami") to always get the latest patched image rather than hardcoding an ID.',
  },
  instance_type: {
    what: 'CPU + RAM size for the virtual machine',
    why: 'Bigger instance type = more performance and more cost. Match it to your workload requirements.',
    cost: v => ({'t2.micro':'~$8/mo','t3.micro':'~$7.59/mo','t3.small':'~$15/mo','t3.medium':'~$30/mo','t3.large':'~$61/mo','m5.large':'~$70/mo','m5.xlarge':'~$140/mo','c5.large':'~$62/mo','r5.large':'~$91/mo'}[v]),
    tip: 't3.micro is free-tier eligible. t3.small or t3.medium suits most production web apps.',
  },
  key_name: {
    what: 'Name of the EC2 Key Pair used for SSH access to the instance',
    why: 'Required to SSH into the instance securely — no password prompt, just the .pem key file.',
    warn: v => (!v || v === '""') ? '⚠ No key pair set — you will not be able to SSH into this instance' : null,
    tip: 'Create the key pair in the AWS console first. Store the .pem file safely — it cannot be re-downloaded.',
  },
  subnet_id: {
    what: 'Which subnet (network segment) to place this resource in',
    why: 'Determines the network zone, availability zone, and routing rules for this resource.',
    tip: 'Use private subnets for databases and internal services. Public subnets for internet-facing load balancers only.',
    relation: 'aws_subnet',
  },
  associate_public_ip_address: {
    what: 'Whether to assign a public IP address to this instance',
    why: 'A public IP lets the instance be reached directly from the internet on its assigned ports.',
    warn: v => v === 'true' ? '⚠ Instance is directly reachable from the internet — ensure the security group restricts to needed ports and known IPs only' : null,
    tip: 'For production, put EC2 behind an Application Load Balancer in a private subnet instead.',
  },
  vpc_security_group_ids: {
    what: 'List of security groups (virtual firewalls) to attach to this instance',
    why: 'Controls which ports and IP addresses can connect to this instance. Multiple groups = union of all rules.',
    warn: v => (!v || v === '[]') ? '⚠ No security group — instance may use a default SG with unintended access rules' : null,
    relation: 'aws_security_group',
  },
  security_group_ids: {
    what: 'Security groups controlling inbound and outbound network traffic',
    why: 'Required for most AWS network resources to define allowed traffic.',
    relation: 'aws_security_group',
  },
  iam_instance_profile: {
    what: 'IAM instance profile (wrapping an IAM role) attached to the EC2 instance',
    why: 'Grants the instance AWS permissions (S3, CloudWatch, SSM, etc.) without storing any credentials on disk.',
    tip: 'Always prefer instance profiles over storing AWS access keys inside the VM.',
    relation: 'aws_iam_instance_profile',
  },
  user_data: {
    what: 'Startup script (Bash/PowerShell) that runs once when the instance first boots',
    why: 'Automates software installation, configuration, and application deployment at launch time.',
    tip: 'Changes to user_data force instance replacement. Use sha256(user_data) in replace_triggered_by to control when.',
  },
  // Storage
  volume_size: {
    what: 'Disk size in gigabytes (GB)',
    why: 'The OS and your application files need storage. Linux root volumes are typically 8-50 GB.',
    tip: 'EBS volume size can be increased without downtime (resize + growpart), but cannot be shrunk.',
  },
  volume_type: {
    what: 'EBS storage performance tier',
    why: 'Different types trade cost vs performance. gp3 offers the best value for most workloads.',
    cost: v => ({gp2:'~$0.10/GB/mo',gp3:'~$0.08/GB/mo',io1:'~$0.125/GB/mo',io2:'~$0.125/GB/mo',st1:'~$0.045/GB/mo',sc1:'~$0.025/GB/mo'}[v]),
    tip: 'gp3 is 20% cheaper than gp2 and lets you independently configure IOPS and throughput.',
  },
  encrypted: {
    what: 'Encrypts the storage volume at rest using AES-256',
    why: 'Protects data if physical hardware is ever accessed. No measurable performance impact on modern instance types.',
    warn: v => v === 'false' ? '⚠ Storage not encrypted — enable for production and any sensitive data' : null,
    tip: 'Encryption is free and transparent. Enable it always — there is no reason not to.',
  },
  // Networking
  cidr_block: {
    what: 'IP address range in CIDR notation — defines available private IP addresses',
    why: 'Sets the pool of IPs. All subnets, instances, and services get addresses from this range.',
    tip: '10.0.0.0/16 gives 65,536 IPs for a VPC. Use /24 subnets (256 IPs each). Avoid overlapping with peered VPCs.',
  },
  availability_zone: {
    what: 'Specific AWS data center (AZ) location for this resource',
    why: 'Spreading resources across multiple AZs provides fault tolerance — one AZ failure doesn\'t take down everything.',
    tip: 'Use at least 2 AZs in production. Prefer data.aws_availability_zones.available to avoid hardcoding AZ names.',
  },
  map_public_ip_on_launch: {
    what: 'Automatically assign a public IP to every instance launched in this subnet',
    why: 'Public subnets need this so instances are reachable from the internet without manual IP assignment.',
    warn: v => v === 'true' ? '⚠ All instances launched here receive public IPs — suitable only for public-facing subnets' : null,
  },
  enable_dns_support: {
    what: 'Enables DNS resolution inside the VPC',
    why: 'Required for AWS service endpoints, Route 53 private hosted zones, and EC2 instance DNS names to work.',
    tip: 'Keep both enable_dns_support and enable_dns_hostnames = true for virtually all VPCs.',
  },
  enable_dns_hostnames: {
    what: 'Assigns human-readable DNS hostnames to EC2 instances (e.g., ip-10-0-1-5.ec2.internal)',
    why: 'Required for Route 53 private hosted zones and makes internal service discovery easier.',
  },
  destination_cidr_block: {
    what: 'Traffic destination this route applies to (0.0.0.0/0 = all internet traffic)',
    why: '0.0.0.0/0 is the "default route" — any traffic not matching a more specific route follows this path.',
    tip: '0.0.0.0/0 → IGW = public subnet (internet access). 0.0.0.0/0 → NAT = private subnet with outbound internet.',
  },
  // Security Group
  from_port: {
    what: 'First port in the allowed range',
    why: 'Common ports: 22=SSH, 80=HTTP, 443=HTTPS, 3306=MySQL, 5432=PostgreSQL, 6379=Redis, 27017=MongoDB.',
  },
  to_port: {
    what: 'Last port in the range (same as from_port for a single port)',
    why: 'from_port=0 + to_port=65535 opens every port — avoid this in production.',
    warn: v => v === '65535' ? '⚠ All 65,535 ports open — restrict to only the ports your application actually needs' : null,
  },
  protocol: {
    what: 'Network protocol: tcp, udp, icmp, or -1 (allow all)',
    why: 'TCP is used for HTTP/HTTPS, databases, and SSH. UDP is for DNS and video streaming.',
    warn: v => v === '-1' ? '⚠ All protocols allowed — restrict to tcp or udp as appropriate' : null,
  },
  // RDS
  engine: {
    what: 'Database engine type (mysql, postgres, mariadb, oracle-se2, sqlserver-ee)',
    why: 'Choose the engine that matches your application\'s SQL dialect and driver.',
  },
  engine_version: {
    what: 'Specific version of the database engine',
    why: 'Newer versions include security patches, bug fixes, and performance improvements.',
    tip: 'Test major version upgrades on a snapshot restore first. Minor version upgrades are usually safe.',
  },
  instance_class: {
    what: 'CPU and memory tier for the RDS instance',
    why: 'Determines database throughput, connection limits, and monthly cost.',
    cost: v => ({'db.t3.micro':'~$15/mo','db.t3.small':'~$30/mo','db.t3.medium':'~$60/mo','db.r5.large':'~$175/mo','db.m5.large':'~$125/mo','db.m5.xlarge':'~$250/mo'}[v]),
  },
  multi_az: {
    what: 'Creates a synchronous standby replica in a different Availability Zone',
    why: 'If the primary database fails, AWS automatically fails over to the standby in ~1-2 minutes.',
    warn: v => v === 'false' ? '⚠ Multi-AZ disabled — no automatic failover. Enable for production databases' : null,
    tip: 'Roughly doubles cost but is non-negotiable for production databases.',
  },
  storage_encrypted: {
    what: 'Encrypts the database storage at rest',
    why: 'Protects sensitive customer data from physical storage access. Required for most compliance standards.',
    warn: v => v === 'false' ? '⚠ Database storage not encrypted — enable for production and compliance' : null,
  },
  deletion_protection: {
    what: 'Prevents accidental database deletion',
    why: 'Must be explicitly disabled before terraform destroy can delete this instance.',
    warn: v => v === 'false' ? '⚠ Deletion protection off — the database can be accidentally destroyed with terraform destroy' : null,
    tip: 'The "seatbelt" that has saved many production databases. Always enable it.',
  },
  skip_final_snapshot: {
    what: 'Whether to skip creating a final backup snapshot before deletion',
    why: 'If true, no snapshot is taken and all data is permanently lost when the instance is deleted.',
    warn: v => v === 'true' ? '⚠ No final snapshot — all database data will be permanently and irreversibly lost on deletion' : null,
    tip: 'Set to false in production and set a meaningful final_snapshot_identifier.',
  },
  backup_retention_period: {
    what: 'Number of days to retain automated backups (0 disables backups)',
    why: 'Enables point-in-time recovery to any second within the retention window.',
    warn: v => v === '0' ? '⚠ Automated backups disabled — cannot restore to a point in time' : null,
    tip: '7 days is a sensible default for production. Maximum is 35 days.',
  },
  allocated_storage: {
    what: 'Initial storage allocation for the database in GB',
    why: 'Sets the starting disk size. AWS can auto-scale it upward if you enable storage_autoscaling.',
    cost: v => v ? `~$${(parseInt(v||0)*0.115).toFixed(2)}/mo (gp2 storage)` : null,
  },
  // Lambda
  runtime: {
    what: 'Programming language and version for the Lambda execution environment',
    why: 'Determines which language your function code runs in and which SDK versions are available.',
    warn: v => ['nodejs12.x','nodejs14.x','python3.6','python3.7','java8'].includes(v)
      ? `⚠ ${v} is end-of-life and no longer receives security patches — upgrade to a supported runtime` : null,
    tip: 'Current recommended runtimes: nodejs20.x, python3.12, java21, go1.x.',
  },
  handler: {
    what: 'Entry point in format filename.function_name',
    why: 'Tells Lambda which specific function to invoke when the trigger fires.',
    tip: 'Node.js: index.handler = "handler" export in index.js. Python: main.lambda_handler = lambda_handler in main.py.',
  },
  memory_size: {
    what: 'Memory allocated in MB — CPU power scales proportionally with memory',
    why: 'More memory = more CPU and typically faster execution. Also directly affects per-millisecond cost.',
    tip: 'Start at 256 MB and profile. Lambda Power Tuning tool can find the optimal memory/cost sweet spot.',
  },
  timeout: {
    what: 'Maximum execution duration in seconds before Lambda forcibly terminates the function',
    why: 'Prevents runaway functions from running indefinitely and incurring unexpected costs.',
    warn: v => parseInt(v) >= 900 ? '⚠ Maximum timeout (15 min) — consider async patterns or Step Functions for long tasks' : null,
  },
  // S3
  bucket: {
    what: 'Globally unique bucket name across all AWS accounts worldwide',
    why: 'The bucket name is part of the URL for all object access — it must be universally unique.',
    tip: 'Prefix with your company + project + environment: myco-projectname-prod. Avoid generic names.',
  },
  force_destroy: {
    what: 'Allow Terraform to delete the bucket even when it still contains objects',
    why: 'By default, Terraform refuses to delete a non-empty bucket as a safety guard.',
    warn: v => v === 'true' ? '⚠ force_destroy=true — ALL objects in this bucket will be permanently deleted when destroyed' : null,
    tip: 'Only use in dev/test environments. Never enable in production.',
  },
  // General / Cross-resource
  tags: {
    what: 'Key-value metadata labels attached to the AWS resource',
    why: 'Essential for cost allocation reports, filtering resources, automation, access control (ABAC), and compliance.',
    tip: 'Minimum recommended tags: Name, Environment, ManagedBy=Terraform, Team, CostCenter.',
  },
  name: {
    what: 'Human-readable identifier that appears as the Name tag in the AWS console',
    why: 'Makes the resource immediately identifiable in the console, CLI output, and monitoring dashboards.',
  },
  vpc_id: {
    what: 'The VPC this resource belongs to',
    why: 'Almost all networking resources (subnets, security groups, route tables, etc.) must be inside a VPC.',
    relation: 'aws_vpc',
  },
  route_table_id: {
    what: 'The route table to associate with this subnet',
    why: 'Associates the subnet with a specific set of routing rules.',
    relation: 'aws_route_table',
  },
  gateway_id: {
    what: 'Internet Gateway that handles this route\'s traffic',
    why: 'The route 0.0.0.0/0 → IGW is what transforms a subnet from private to public-facing.',
    relation: 'aws_internet_gateway',
  },
  nat_gateway_id: {
    what: 'NAT Gateway that handles outbound internet traffic for this private subnet\'s route',
    why: 'The route 0.0.0.0/0 → NAT lets private instances reach the internet without being exposed.',
    relation: 'aws_nat_gateway',
  },
  allocation_id: {
    what: 'Elastic IP to assign to this NAT Gateway',
    why: 'NAT Gateways need a static public IP to masquerade outbound private subnet traffic.',
    relation: 'aws_eip',
  },
  kms_key_id: {
    what: 'KMS encryption key used to encrypt this resource\'s data',
    why: 'Customer-managed keys give you full control, auditability, and the ability to revoke access.',
    relation: 'aws_kms_key',
  },
  role: {
    what: 'IAM role ARN this Lambda function assumes at execution time',
    why: 'The execution role defines what AWS services and resources the function is allowed to access.',
    relation: 'aws_iam_role',
  },
  role_arn: {
    what: 'ARN of the IAM role to assign to this resource',
    why: 'Grants the resource a specific set of AWS permissions via the role\'s attached policies.',
    relation: 'aws_iam_role',
  },
  description: {
    what: 'Human-readable description of this resource\'s purpose',
    why: 'Helps team members understand why this resource exists when browsing the AWS console.',
    tip: 'Write intent, not just the name: "ALB SG — allow 443 from internet" not just "alb-sg".',
  },
};

// --- HCL parser --------------------------------------------------------------
function parseHCLBlocks(hcl) {
  if (!hcl?.trim()) return [];
  const blocks = [];
  const lines   = hcl.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line    = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) { i++; continue; }

    const m = trimmed.match(/^(resource|data|variable|output|module|provider|terraform|locals)\s*(.*?)\s*\{?\s*$/);
    if (!m) { i++; continue; }

    const type   = m[1];
    const labels = (m[2] || '').match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];

    const blockLines = [line];
    let depth = (line.match(/\{/g)||[]).length - (line.match(/\}/g)||[]).length;
    i++;

    while (i < lines.length && (depth > 0 || blockLines.length === 1)) {
      const l = lines[i];
      depth  += (l.match(/\{/g)||[]).length - (l.match(/\}/g)||[]).length;
      blockLines.push(l);
      i++;
      if (depth <= 0) break;
    }

    blocks.push({ type, labels, body: blockLines.join('\n') });
  }
  return blocks;
}

// Extract immediate key = value fields (depth 1 inside the block)
function extractFields(body) {
  const fields = [];
  const re = /^ {2}(\w+)\s*=\s*(.+?)(?:\s*#.*)?$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const raw = m[2].trim();
    if (raw === '{' || raw.endsWith('{')) continue; // skip nested block openers
    fields.push({ key: m[1], value: raw.replace(/^"(.*)"$/, '$1'), raw });
  }
  return fields;
}

// --- Value coloring -----------------------------------------------------------
function ValueChip({ val, fg2, fg3 }) {
  const isRef   = /^(aws_|data\.|module\.|var\.|local\.)/.test(val);
  const isBool  = val === 'true' || val === 'false';
  const isNum   = /^\d+$/.test(val);
  const isStr   = !isRef && !isBool && !isNum;

  const color = isRef  ? '#60a5fa'
              : isBool ? (val === 'true' ? '#4ade80' : '#f87171')
              : isNum  ? '#fb923c'
              : '#a3e635';

  return (
    <code style={{
      fontSize: 11, padding: '1px 6px', borderRadius: 4,
      background: color + '15', color, fontFamily: 'JetBrains Mono, monospace',
      maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      display: 'inline-block',
    }}>
      {val.length > 28 ? val.slice(0, 27) + '…' : val}
    </code>
  );
}

// --- Single field row ---------------------------------------------------------
function FieldRow({ fieldKey, fieldValue, c }) {
  const [open, setOpen] = useState(false);
  const kb   = FIELD_KB[fieldKey] || {};
  const warn = typeof kb.warn === 'function' ? kb.warn(fieldValue) : null;
  const cost = typeof kb.cost === 'function' ? kb.cost(fieldValue) : null;

  return (
    <div style={{
      borderBottom: `1px solid ${c.bd}`,
      cursor: kb.what ? 'pointer' : 'default',
    }}
      onClick={() => kb.what && setOpen(o => !o)}>
      {/* Summary row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap' }}>
        <code style={{
          fontSize: 11, color: c.accent, fontFamily: 'JetBrains Mono, monospace',
          minWidth: 160, flexShrink: 0,
        }}>
          {fieldKey}
        </code>
        <ValueChip val={fieldValue} fg2={c.fg2} fg3={c.fg3} />
        {warn && (
          <span style={{
            fontSize: 10, color: '#ef4444', background: '#ef444415',
            border: '1px solid #ef444430', borderRadius: 10, padding: '1px 7px', flexShrink: 0,
          }}>
            {warn}
          </span>
        )}
        {cost && (
          <span style={{
            fontSize: 10, color: '#00D4A1', background: '#00D4A115',
            border: '1px solid #00D4A130', borderRadius: 10, padding: '1px 7px', marginLeft: 'auto', flexShrink: 0,
          }}>
            💰 {cost}
          </span>
        )}
        {kb.what && (
          <span style={{ fontSize: 10, color: c.fg3, marginLeft: warn || cost ? 0 : 'auto' }}>
            {open ? '▲' : '▼'}
          </span>
        )}
      </div>
      {/* Expanded explanation */}
      {open && kb.what && (
        <div style={{
          padding: '8px 12px 10px 170px', display: 'flex', flexDirection: 'column', gap: 5,
          background: c.bg2, borderTop: `1px solid ${c.bd}`,
        }}>
          {kb.what && (
            <div style={{ display: 'flex', gap: 6, fontSize: 12, color: c.fg2, lineHeight: 1.5 }}>
              <span style={{ color: '#60a5fa', flexShrink: 0 }}>📋 What:</span>
              <span>{kb.what}</span>
            </div>
          )}
          {kb.why && (
            <div style={{ display: 'flex', gap: 6, fontSize: 12, color: c.fg2, lineHeight: 1.5 }}>
              <span style={{ color: '#a78bfa', flexShrink: 0 }}>❓ Why:</span>
              <span>{kb.why}</span>
            </div>
          )}
          {kb.tip && (
            <div style={{
              fontSize: 11, color: c.accent, background: c.accentSoft,
              border: `1px solid ${c.accentBd}`, borderRadius: 6,
              padding: '5px 10px', lineHeight: 1.5, marginTop: 3,
            }}>
              💡 {kb.tip}
            </div>
          )}
          {kb.relation && (
            <div style={{ fontSize: 11, color: '#60a5fa' }}>
              🔗 References: <code style={{ fontFamily: 'monospace' }}>{kb.relation}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Block card ---------------------------------------------------------------
function BlockCard({ block, index, c }) {
  const [expanded, setExpanded] = useState(index < 3); // first 3 blocks open

  const { type, labels, body } = block;
  const resourceType = type === 'resource' ? labels[0] : null;
  const resourceName = type === 'resource' ? labels[1] : (labels[0] || null);
  const kb     = resourceType ? (RESOURCE_KB[resourceType] || null) : null;
  const color  = kb?.color || '#64748b';
  const icon   = kb?.icon  || (type === 'variable' ? '🔧' : type === 'output' ? '📤' : type === 'provider' ? '🔌' : '📦');
  const label  = kb?.label || (resourceType ? resourceType.replace('aws_', '').replace(/_/g, ' ') : type);

  const fields = useMemo(() => extractFields(body), [body]);
  const warnings = fields.filter(f => {
    const warn = FIELD_KB[f.key]?.warn;
    return typeof warn === 'function' && warn(f.value);
  });

  return (
    <div style={{
      border: `1px solid ${c.bd}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 10,
      overflow: 'hidden',
      background: c.bg,
      position: 'relative',
      zIndex: 0,
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: c.bg2, border: 'none', cursor: 'pointer',
          textAlign: 'left', position: 'relative', zIndex: 2,
        }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>{label}</div>
          <div style={{ fontSize: 10, color: c.fg3, fontFamily: 'JetBrains Mono, monospace', marginTop: 1 }}>
            {type}{labels.map(l => ` "${l}"`).join('')}
          </div>
        </div>
        {warnings.length > 0 && (
          <span style={{
            fontSize: 10, background: '#ef444415', color: '#ef4444',
            border: '1px solid #ef444430', borderRadius: 10, padding: '2px 8px', flexShrink: 0,
          }}>
            ⚠ {warnings.length} {warnings.length === 1 ? 'issue' : 'issues'}
          </span>
        )}
        <span style={{ color: c.fg3, fontSize: 12, flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ position: 'relative', zIndex: 1 }}>
          {/* What / Why / After Apply */}
          {kb && (
            <div style={{
              padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
              borderBottom: `1px solid ${c.bd}`, background: c.bg,
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, alignItems: 'start', gridAutoRows: 'minmax(0, auto)' }}>
                {[
                  { icon: '📋', label: 'WHAT IT IS',    text: kb.what,   bg: '#3b82f615', border: '#3b82f630' },
                  { icon: '❓', label: 'WHY IT\'S USED', text: kb.why,    bg: '#a78bfa15', border: '#a78bfa30' },
                  { icon: '✅', label: 'AFTER APPLY',    text: kb.impact, bg: '#10b98115', border: '#10b98130' },
                ].map(({ icon, label, text, bg, border }) => (
                  <div key={label} style={{
                    padding: '8px 10px', borderRadius: 8,
                    background: bg, border: `1px solid ${border}`,
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: c.fg3, letterSpacing: '0.08em', marginBottom: 4 }}>
                      {icon} {label}
                    </div>
                    <div style={{ fontSize: 12, color: c.fg2, lineHeight: 1.55 }}>{text}</div>
                  </div>
                ))}
              </div>

              {/* Architecture flow */}
              {kb.flow && (
                <div style={{
                  fontSize: 11, color: c.accent, padding: '6px 10px', borderRadius: 6,
                  background: c.accentSoft, border: `1px solid ${c.accentBd}`,
                }}>
                  🔄 <strong>Flow:</strong> {kb.flow}
                </div>
              )}
            </div>
          )}

          {/* Variable / output / provider blocks */}
          {!kb && type === 'variable' && (
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${c.bd}`, fontSize: 12, color: c.fg2, lineHeight: 1.55 }}>
              <strong>📋 What:</strong> An input parameter — lets you reuse this configuration across environments without editing the source.<br />
              <strong>❓ Why:</strong> Variables keep your code DRY. Pass different values per environment (dev/staging/prod).<br />
              <strong>✅ After apply:</strong> Use -var="name=value" on the CLI or a terraform.tfvars file.
            </div>
          )}
          {!kb && type === 'output' && (
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${c.bd}`, fontSize: 12, color: c.fg2, lineHeight: 1.55 }}>
              <strong>📋 What:</strong> Exports a value from this configuration — readable via <code>terraform output</code>.<br />
              <strong>❓ Why:</strong> Outputs expose useful values (IP addresses, ARNs, endpoints) to humans and downstream pipelines.<br />
              <strong>✅ After apply:</strong> Run <code>terraform output {labels[0]}</code> to read the value.
            </div>
          )}
          {!kb && type === 'provider' && (
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${c.bd}`, fontSize: 12, color: c.fg2, lineHeight: 1.55 }}>
              <strong>📋 What:</strong> Tells Terraform which cloud platform plugin to use and how to authenticate.<br />
              <strong>❓ Why:</strong> Without a provider block, Terraform doesn\'t know where to create resources.<br />
              <strong>✅ After apply:</strong> Terraform downloads the provider plugin and uses it for all <code>aws_*</code> resources.
            </div>
          )}

          {/* Fields table */}
          {fields.length > 0 && (
            <div>
              <div style={{
                padding: '5px 10px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                color: c.fg3, background: c.bg3, borderBottom: `1px solid ${c.bd}`,
                textTransform: 'uppercase',
              }}>
                ⚙ Fields — click any row for details
              </div>
              <div>
                {fields.map(f => (
                  <FieldRow key={f.key} fieldKey={f.key} fieldValue={f.value} c={c} />
                ))}
              </div>
            </div>
          )}

          {/* Connections */}
          {kb?.connections?.length > 0 && (
            <div style={{
              padding: '8px 14px', display: 'flex', alignItems: 'center', flexWrap: 'wrap',
              gap: 6, borderTop: `1px solid ${c.bd}`, background: c.bg2,
            }}>
              <span style={{ fontSize: 10, color: c.fg3, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>
                🔗 Typically connects to:
              </span>
              {kb.connections.map(ct => {
                const ckb = RESOURCE_KB[ct];
                return (
                  <span key={ct} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10, border: `1px solid ${c.bd}`,
                    background: c.bg3, color: ckb?.color || c.fg3,
                  }}>
                    {ckb?.icon || '*'} {ckb?.label?.split(' ')[0] || ct.replace('aws_', '')}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Architecture summary bar -------------------------------------------------
function ArchSummary({ blocks, c }) {
  const counts = {};
  for (const b of blocks) {
    if (b.type === 'resource' && b.labels[0]) {
      const kb = RESOURCE_KB[b.labels[0]];
      const label = kb?.label?.split(' ')[0] || b.labels[0].replace('aws_', '').replace(/_/g, ' ');
      counts[label] = (counts[label] || 0) + 1;
    }
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;

  // Build architecture flow description
  const has = (t) => blocks.some(b => b.type === 'resource' && b.labels[0] === t);
  const flowParts = [];
  if (has('aws_internet_gateway') || has('aws_cloudfront_distribution')) flowParts.push('Internet');
  if (has('aws_alb')) flowParts.push('Load Balancer');
  if (has('aws_instance') || has('aws_eks_cluster') || has('aws_ecs_cluster') || has('aws_lambda_function')) flowParts.push('Compute');
  if (has('aws_db_instance') || has('aws_elasticache_cluster') || has('aws_dynamodb_table')) flowParts.push('Data Layer');
  if (has('aws_s3_bucket') || has('aws_sqs_queue') || has('aws_sns_topic')) flowParts.push('Services');

  return (
    <div style={{
      padding: '10px 14px', background: c.bg2, border: `1px solid ${c.bd}`,
      borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: c.fg, display: 'flex', alignItems: 'center', gap: 6 }}>
        📊 Architecture Overview
        <span style={{
          fontSize: 10, padding: '1px 8px', borderRadius: 10, marginLeft: 4,
          background: c.accentSoft, color: c.accent, border: `1px solid ${c.accentBd}`,
        }}>
          {blocks.filter(b => b.type === 'resource').length} resources
        </span>
      </div>

      {/* Resource type chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {entries.map(([label, count]) => {
          const matchKb = Object.values(RESOURCE_KB).find(kb => kb.label.startsWith(label));
          return (
            <span key={label} style={{
              fontSize: 11, padding: '3px 9px', borderRadius: 10,
              background: (matchKb?.color || c.fg3) + '18',
              border: `1px solid ${(matchKb?.color || c.fg3) + '40'}`,
              color: matchKb?.color || c.fg3,
            }}>
              {matchKb?.icon || '*'} {count > 1 ? `${count}× ` : ''}{label}
            </span>
          );
        })}
      </div>

      {/* Architecture flow */}
      {flowParts.length > 1 && (
        <div style={{ fontSize: 11, color: c.fg2, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ color: c.fg3 }}>Traffic flow:</span>
          {flowParts.map((p, i) => (
            <React.Fragment key={p}>
              <span style={{ color: c.accent, fontWeight: 600 }}>{p}</span>
              {i < flowParts.length - 1 && <span style={{ color: c.fg3 }}>→</span>}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main export --------------------------------------------------------------
export default function HclExplainer({ hcl, c }) {
  const blocks = useMemo(() => parseHCLBlocks(hcl), [hcl]);

  // Count total warnings across all blocks
  const totalWarnings = useMemo(() => {
    let n = 0;
    for (const b of blocks) {
      const fields = extractFields(b.body);
      for (const f of fields) {
        const w = FIELD_KB[f.key]?.warn;
        if (typeof w === 'function' && w(f.value)) n++;
      }
    }
    return n;
  }, [blocks]);

  if (!hcl?.trim()) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100%', gap: 12, padding: 24, color: c.fg3, textAlign: 'center',
      }}>
        <div style={{ fontSize: 40 }}>📖</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: c.fg2 }}>No code to explain yet</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 340 }}>
          Select a service from the left panel and configure it. Then switch back to this
          tab to see a full plain-English explanation of every resource and field.
        </div>
        <div style={{
          fontSize: 12, padding: '8px 14px', borderRadius: 8, marginTop: 4,
          background: c.accentSoft, border: `1px solid ${c.accentBd}`, color: c.accent,
          lineHeight: 1.6,
        }}>
          💡 You'll see: <strong>What</strong> each block does · <strong>Why</strong> it's needed ·
          <strong> After Apply</strong> impact · Field-by-field details · Cost estimates · Security warnings
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: '14px 16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box',
    }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>
          🔍 Architecture Explanation
        </div>
        <span style={{ fontSize: 11, color: c.fg3, marginRight: 'auto' }}>
          {blocks.length} blocks · click any field row for details
        </span>
        {totalWarnings > 0 && (
          <span style={{
            fontSize: 11, padding: '2px 10px', borderRadius: 10,
            background: '#ef444415', color: '#ef4444', border: '1px solid #ef444430',
          }}>
            ⚠ {totalWarnings} security/config {totalWarnings === 1 ? 'issue' : 'issues'} found
          </span>
        )}
      </div>

      {/* Architecture summary */}
      <ArchSummary blocks={blocks} c={c} />

      {/* Block cards */}
      {blocks.map((block, i) => (
        <BlockCard key={i} block={block} index={i} c={c} />
      ))}

      {/* Footer tip */}
      <div style={{
        fontSize: 11, color: c.fg3, padding: '8px 12px', borderRadius: 8,
        background: c.bg2, border: `1px solid ${c.bd}`, lineHeight: 1.6,
      }}>
        💡 <strong>Tip:</strong> Click any field name to expand a plain-English explanation.
        Orange badges = warnings. Green badges = estimated cost. Blue references = links to other resources.
      </div>
    </div>
  );
}
