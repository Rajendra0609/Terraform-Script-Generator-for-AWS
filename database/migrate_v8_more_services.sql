-- ═══════════════════════════════════════════════════════════════════════════
-- migrate_v8_more_services.sql
-- Adds ~65 new AWS services covering: Networking (VPC Peering, VPN, Direct
-- Connect, NLB, Network Firewall…), Analytics, App Integration, Machine
-- Learning, extended CI/CD, Containers, Security, Compute, Database, Admin.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- NETWORKING – VPC Connectivity & Advanced
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc_peering', 'VPC Peering Connection', 'Networking', 'PEER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_peering","required":true},{"id":"vpc_id","label":"Requester VPC ID / Ref","type":"text","default":"aws_vpc.requester.id","required":true},{"id":"peer_vpc_id","label":"Accepter VPC ID / Ref","type":"text","default":"aws_vpc.accepter.id","required":true},{"id":"peer_region","label":"Peer Region (leave blank if same)","type":"text","default":""},{"id":"auto_accept","label":"Auto Accept","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_vpc_peering_connection" "{{name}}" {
  vpc_id        = {{vpc_id}}
  peer_vpc_id   = {{peer_vpc_id}}
  auto_accept   = {{auto_accept}}

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'elastic_ip', 'Elastic IP Address', 'Networking', 'EIP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_eip","required":true},{"id":"instance_id","label":"Instance ID to Associate (optional)","type":"text","default":""}]',
  'resource "aws_eip" "{{name}}" {
  domain = "vpc"

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'network_acl', 'Network ACL', 'Networking', 'NACL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_nacl","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"ingress_rule_number","label":"Ingress Rule Number","type":"number","default":"100"},{"id":"ingress_cidr","label":"Ingress CIDR Block","type":"text","default":"0.0.0.0/0"},{"id":"ingress_action","label":"Ingress Action","type":"select","options":["allow","deny"],"default":"allow"},{"id":"egress_cidr","label":"Egress CIDR Block","type":"text","default":"0.0.0.0/0"}]',
  'resource "aws_network_acl" "{{name}}" {
  vpc_id = {{vpc_id}}

  ingress {
    rule_no    = {{ingress_rule_number}}
    protocol   = "-1"
    action     = "{{ingress_action}}"
    cidr_block = "{{ingress_cidr}}"
    from_port  = 0
    to_port    = 0
  }

  egress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = "{{egress_cidr}}"
    from_port  = 0
    to_port    = 0
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc_endpoint', 'VPC Endpoint', 'Networking', 'VPCE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_vpce","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"service_name","label":"Service Name","type":"select","options":["com.amazonaws.us-east-1.s3","com.amazonaws.us-east-1.dynamodb","com.amazonaws.us-east-1.ec2","com.amazonaws.us-east-1.ecr.api","com.amazonaws.us-east-1.ecr.dkr","com.amazonaws.us-east-1.ssm","com.amazonaws.us-east-1.secretsmanager","com.amazonaws.us-east-1.kms","com.amazonaws.us-east-1.logs","com.amazonaws.us-east-1.monitoring"],"default":"com.amazonaws.us-east-1.s3"},{"id":"endpoint_type","label":"Endpoint Type","type":"select","options":["Gateway","Interface"],"default":"Gateway"},{"id":"route_table_ids","label":"Route Table IDs (Gateway type, comma-sep)","type":"text","default":"aws_route_table.private.id"}]',
  'resource "aws_vpc_endpoint" "{{name}}" {
  vpc_id            = {{vpc_id}}
  service_name      = "{{service_name}}"
  vpc_endpoint_type = "{{endpoint_type}}"

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'customer_gateway', 'Customer Gateway', 'Networking', 'CGW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cgw","required":true},{"id":"bgp_asn","label":"BGP ASN","type":"number","default":"65000"},{"id":"ip_address","label":"On-Premises Public IP","type":"text","default":"203.0.113.1","required":true},{"id":"type","label":"Type","type":"select","options":["ipsec.1"],"default":"ipsec.1"}]',
  'resource "aws_customer_gateway" "{{name}}" {
  bgp_asn    = {{bgp_asn}}
  ip_address = "{{ip_address}}"
  type       = "{{type}}"

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpn_connection', 'Site-to-Site VPN', 'Networking', 'VPN',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_vpn","required":true},{"id":"customer_gateway_id","label":"Customer Gateway ID / Ref","type":"text","default":"aws_customer_gateway.my_cgw.id","required":true},{"id":"transit_gateway_id","label":"Transit Gateway ID / Ref","type":"text","default":"aws_ec2_transit_gateway.tgw.id"},{"id":"type","label":"Type","type":"select","options":["ipsec.1"],"default":"ipsec.1"},{"id":"static_routes_only","label":"Static Routes Only","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_vpn_connection" "{{name}}" {
  customer_gateway_id   = {{customer_gateway_id}}
  transit_gateway_id    = {{transit_gateway_id}}
  type                  = "{{type}}"
  static_routes_only    = {{static_routes_only}}

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'direct_connect_gateway', 'Direct Connect Gateway', 'Networking', 'DX',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_dx_gw","required":true},{"id":"gateway_name","label":"Gateway Name","type":"text","default":"my-dx-gateway","required":true},{"id":"amazon_side_asn","label":"Amazon Side ASN","type":"number","default":"64512"}]',
  'resource "aws_dx_gateway" "{{name}}" {
  name            = "{{gateway_name}}"
  amazon_side_asn = {{amazon_side_asn}}
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'network_load_balancer', 'Network Load Balancer', 'Networking', 'NLB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_nlb","required":true},{"id":"nlb_name","label":"NLB Name","type":"text","default":"my-network-lb","required":true},{"id":"internal","label":"Internal (private)","type":"select","options":["false","true"],"default":"false"},{"id":"listener_port","label":"Listener Port","type":"number","default":"443"},{"id":"listener_protocol","label":"Listener Protocol","type":"select","options":["TCP","TLS","UDP","TCP_UDP"],"default":"TCP"},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.public_a.id, aws_subnet.public_b.id"}]',
  'resource "aws_lb" "{{name}}" {
  name               = "{{nlb_name}}"
  internal           = {{internal}}
  load_balancer_type = "network"

  dynamic "subnet_mapping" {
    for_each = [{{subnet_ids}}]
    content { subnet_id = subnet_mapping.value }
  }

  tags = {
    Name      = "{{nlb_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_lb_listener" "{{name}}" {
  load_balancer_arn = aws_lb.{{name}}.arn
  port              = {{listener_port}}
  protocol          = "{{listener_protocol}}"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.{{name}}.arn
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc_flow_logs', 'VPC Flow Logs', 'Networking', 'FLOW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_flow_logs","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"traffic_type","label":"Traffic Type","type":"select","options":["ALL","ACCEPT","REJECT"],"default":"ALL"},{"id":"log_destination","label":"Log Destination (S3 or CWL ARN)","type":"text","default":"aws_cloudwatch_log_group.flow_logs.arn"},{"id":"log_destination_type","label":"Destination Type","type":"select","options":["cloud-watch-logs","s3","kinesis-data-firehose"],"default":"cloud-watch-logs"}]',
  'resource "aws_flow_log" "{{name}}" {
  vpc_id                   = {{vpc_id}}
  traffic_type             = "{{traffic_type}}"
  log_destination_type     = "{{log_destination_type}}"
  log_destination          = {{log_destination}}
  iam_role_arn             = aws_iam_role.{{name}}_role.arn

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'global_accelerator', 'Global Accelerator', 'Networking', 'GA',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ga","required":true},{"id":"accelerator_name","label":"Accelerator Name","type":"text","default":"my-global-accelerator","required":true},{"id":"ip_address_type","label":"IP Address Type","type":"select","options":["IPV4","DUAL_STACK"],"default":"IPV4"},{"id":"enabled","label":"Enabled","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_globalaccelerator_accelerator" "{{name}}" {
  name            = "{{accelerator_name}}"
  ip_address_type = "{{ip_address_type}}"
  enabled         = {{enabled}}

  attributes {
    flow_logs_enabled   = false
    flow_logs_s3_bucket = ""
    flow_logs_s3_prefix = ""
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'network_firewall', 'AWS Network Firewall', 'Networking', 'NFW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_nfw","required":true},{"id":"firewall_name","label":"Firewall Name","type":"text","default":"my-network-firewall","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"subnet_id","label":"Firewall Subnet ID / Reference","type":"text","default":"aws_subnet.firewall.id","required":true}]',
  'resource "aws_networkfirewall_firewall_policy" "{{name}}" {
  name = "{{firewall_name}}-policy"

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]
  }
}

resource "aws_networkfirewall_firewall" "{{name}}" {
  name                = "{{firewall_name}}"
  firewall_policy_arn = aws_networkfirewall_firewall_policy.{{name}}.arn
  vpc_id              = {{vpc_id}}

  subnet_mapping {
    subnet_id = {{subnet_id}}
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMPUTE – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'launch_template', 'EC2 Launch Template', 'Compute', 'LT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_lt","required":true},{"id":"lt_name","label":"Launch Template Name","type":"text","default":"my-launch-template","required":true},{"id":"ami_id","label":"AMI ID","type":"text","default":"ami-0c55b159cbfafe1f0","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["t3.micro","t3.small","t3.medium","t3.large","m5.large","m5.xlarge","c5.large","c5.xlarge"],"default":"t3.micro"},{"id":"key_name","label":"Key Pair Name","type":"text","default":"my-key-pair"},{"id":"volume_size","label":"Root Volume Size (GB)","type":"number","default":"20"},{"id":"ebs_optimized","label":"EBS Optimized","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_launch_template" "{{name}}" {
  name          = "{{lt_name}}"
  image_id      = "{{ami_id}}"
  instance_type = "{{instance_type}}"
  key_name      = "{{key_name}}"
  ebs_optimized = {{ebs_optimized}}

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = {{volume_size}}
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  monitoring { enabled = true }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name      = "{{lt_name}}"
      ManagedBy = "Terraform"
    }
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'elastic_beanstalk', 'Elastic Beanstalk', 'Compute', 'EB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_eb","required":true},{"id":"app_name","label":"Application Name","type":"text","default":"my-app","required":true},{"id":"env_name","label":"Environment Name","type":"text","default":"my-app-prod","required":true},{"id":"platform","label":"Platform","type":"select","options":["64bit Amazon Linux 2 v3.5.9 running Node.js 18","64bit Amazon Linux 2 v3.5.9 running Python 3.9","64bit Amazon Linux 2 v4.0.1 running Docker","64bit Amazon Linux 2 v3.4.3 running Java 11","64bit Amazon Linux 2 v3.1.1 running Go 1"],"default":"64bit Amazon Linux 2 v3.5.9 running Node.js 18"},{"id":"instance_type","label":"Instance Type","type":"select","options":["t3.micro","t3.small","t3.medium","m5.large"],"default":"t3.micro"},{"id":"min_instances","label":"Min Instances","type":"number","default":"1"},{"id":"max_instances","label":"Max Instances","type":"number","default":"4"}]',
  'resource "aws_elastic_beanstalk_application" "{{name}}" {
  name        = "{{app_name}}"
  description = "Managed by Terraform"
}

resource "aws_elastic_beanstalk_environment" "{{name}}" {
  name                = "{{env_name}}"
  application         = aws_elastic_beanstalk_application.{{name}}.name
  solution_stack_name = "{{platform}}"

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "InstanceType"
    value     = "{{instance_type}}"
  }

  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MinSize"
    value     = "{{min_instances}}"
  }

  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MaxSize"
    value     = "{{max_instances}}"
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'spot_fleet', 'EC2 Spot Fleet', 'Compute', 'SPOT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_spot","required":true},{"id":"target_capacity","label":"Target Capacity","type":"number","default":"2"},{"id":"ami_id","label":"AMI ID","type":"text","default":"ami-0c55b159cbfafe1f0","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["t3.micro","t3.small","t3.medium","m5.large","m5.xlarge"],"default":"t3.medium"},{"id":"allocation_strategy","label":"Allocation Strategy","type":"select","options":["lowestPrice","diversified","capacityOptimized"],"default":"capacityOptimized"},{"id":"spot_price","label":"Max Spot Price (USD/hr, blank = on-demand)","type":"text","default":""}]',
  'resource "aws_spot_fleet_request" "{{name}}" {
  iam_fleet_role        = aws_iam_role.{{name}}_spot.arn
  target_capacity       = {{target_capacity}}
  allocation_strategy   = "{{allocation_strategy}}"
  terminate_instances_with_expiration = true

  launch_specification {
    instance_type = "{{instance_type}}"
    ami           = "{{ami_id}}"
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'fsx', 'FSx File System', 'Storage', 'FSX',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_fsx","required":true},{"id":"file_system_type","label":"File System Type","type":"select","options":["LUSTRE","WINDOWS","ONTAP","OPENZFS"],"default":"LUSTRE"},{"id":"storage_capacity","label":"Storage Capacity (GB)","type":"number","default":"1200"},{"id":"subnet_id","label":"Subnet ID / Reference","type":"text","default":"aws_subnet.private_a.id","required":true},{"id":"throughput_capacity","label":"Throughput (MB/s, Windows/ONTAP only)","type":"number","default":"64"}]',
  'resource "aws_fsx_lustre_file_system" "{{name}}" {
  storage_capacity = {{storage_capacity}}
  subnet_ids       = [{{subnet_id}}]

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'datasync_task', 'DataSync Task', 'Storage', 'SYNC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_datasync","required":true},{"id":"source_location_arn","label":"Source Location ARN","type":"text","default":"aws_datasync_location_s3.source.arn","required":true},{"id":"destination_location_arn","label":"Destination Location ARN","type":"text","default":"aws_datasync_location_s3.dest.arn","required":true},{"id":"schedule_expression","label":"Schedule (cron or rate)","type":"text","default":"cron(0 2 * * ? *)"}]',
  'resource "aws_datasync_task" "{{name}}" {
  source_location_arn      = {{source_location_arn}}
  destination_location_arn = {{destination_location_arn}}

  schedule {
    schedule_expression = "{{schedule_expression}}"
  }

  options {
    bytes_per_second = -1
    verify_mode      = "ONLY_FILES_TRANSFERRED"
    overwrite_mode   = "ALWAYS"
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- DATABASE – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'aurora_cluster', 'Aurora Cluster', 'Database', 'AURA',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_aurora","required":true},{"id":"cluster_identifier","label":"Cluster Identifier","type":"text","default":"my-aurora-cluster","required":true},{"id":"engine","label":"Engine","type":"select","options":["aurora-mysql","aurora-postgresql"],"default":"aurora-postgresql"},{"id":"engine_version","label":"Engine Version","type":"text","default":"15.3"},{"id":"database_name","label":"Database Name","type":"text","default":"appdb"},{"id":"master_username","label":"Master Username","type":"text","default":"admin"},{"id":"instance_class","label":"Instance Class","type":"select","options":["db.t3.medium","db.r6g.large","db.r6g.xlarge","db.r7g.large","db.serverless"],"default":"db.t3.medium"},{"id":"instance_count","label":"Number of Instances","type":"number","default":"2"},{"id":"backup_retention","label":"Backup Retention (days)","type":"number","default":"7"}]',
  'resource "aws_rds_cluster" "{{name}}" {
  cluster_identifier      = "{{cluster_identifier}}"
  engine                  = "{{engine}}"
  engine_version          = "{{engine_version}}"
  database_name           = "{{database_name}}"
  master_username         = "{{master_username}}"
  master_password         = var.db_password
  backup_retention_period = {{backup_retention}}
  skip_final_snapshot     = false

  tags = {
    Name      = "{{cluster_identifier}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_rds_cluster_instance" "{{name}}" {
  count              = {{instance_count}}
  identifier         = "{{cluster_identifier}}-${count.index}"
  cluster_identifier = aws_rds_cluster.{{name}}.id
  instance_class     = "{{instance_class}}"
  engine             = aws_rds_cluster.{{name}}.engine
  engine_version     = aws_rds_cluster.{{name}}.engine_version
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'redshift_cluster', 'Redshift Cluster', 'Database', 'RS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_redshift","required":true},{"id":"cluster_identifier","label":"Cluster Identifier","type":"text","default":"my-redshift","required":true},{"id":"database_name","label":"Database Name","type":"text","default":"datawarehouse"},{"id":"master_username","label":"Master Username","type":"text","default":"admin"},{"id":"node_type","label":"Node Type","type":"select","options":["dc2.large","dc2.8xlarge","ra3.xlplus","ra3.4xlarge","ra3.16xlarge"],"default":"dc2.large"},{"id":"number_of_nodes","label":"Number of Nodes","type":"number","default":"2"},{"id":"encrypted","label":"Encrypted","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_redshift_cluster" "{{name}}" {
  cluster_identifier = "{{cluster_identifier}}"
  database_name      = "{{database_name}}"
  master_username    = "{{master_username}}"
  master_password    = var.redshift_password
  node_type          = "{{node_type}}"
  number_of_nodes    = {{number_of_nodes}}
  encrypted          = {{encrypted}}

  skip_final_snapshot = false

  tags = {
    Name      = "{{cluster_identifier}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'opensearch_domain', 'OpenSearch Domain', 'Database', 'ES',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_opensearch","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"my-search","required":true},{"id":"engine_version","label":"Engine Version","type":"select","options":["OpenSearch_2.11","OpenSearch_2.9","OpenSearch_2.7","Elasticsearch_7.10"],"default":"OpenSearch_2.11"},{"id":"instance_type","label":"Instance Type","type":"select","options":["t3.small.search","t3.medium.search","m6g.large.search","r6g.large.search","c6g.large.search"],"default":"t3.medium.search"},{"id":"instance_count","label":"Instance Count","type":"number","default":"2"},{"id":"volume_size","label":"Volume Size (GB)","type":"number","default":"20"}]',
  'resource "aws_opensearch_domain" "{{name}}" {
  domain_name    = "{{domain_name}}"
  engine_version = "{{engine_version}}"

  cluster_config {
    instance_type  = "{{instance_type}}"
    instance_count = {{instance_count}}
  }

  ebs_options {
    ebs_enabled = true
    volume_size = {{volume_size}}
    volume_type = "gp3"
  }

  encrypt_at_rest { enabled = true }
  node_to_node_encryption { enabled = true }

  domain_endpoint_options {
    enforce_https = true
  }

  tags = {
    Name      = "{{domain_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'documentdb_cluster', 'DocumentDB Cluster', 'Database', 'DOC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_docdb","required":true},{"id":"cluster_identifier","label":"Cluster Identifier","type":"text","default":"my-docdb","required":true},{"id":"master_username","label":"Master Username","type":"text","default":"admin"},{"id":"instance_class","label":"Instance Class","type":"select","options":["db.t3.medium","db.r5.large","db.r5.xlarge","db.r6g.large"],"default":"db.t3.medium"},{"id":"instance_count","label":"Number of Instances","type":"number","default":"2"},{"id":"backup_retention","label":"Backup Retention (days)","type":"number","default":"7"}]',
  'resource "aws_docdb_cluster" "{{name}}" {
  cluster_identifier      = "{{cluster_identifier}}"
  master_username         = "{{master_username}}"
  master_password         = var.docdb_password
  backup_retention_period = {{backup_retention}}
  skip_final_snapshot     = false
  storage_encrypted       = true

  tags = {
    Name      = "{{cluster_identifier}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_docdb_cluster_instance" "{{name}}" {
  count              = {{instance_count}}
  identifier         = "{{cluster_identifier}}-${count.index}"
  cluster_identifier = aws_docdb_cluster.{{name}}.id
  instance_class     = "{{instance_class}}"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'rds_proxy', 'RDS Proxy', 'Database', 'PRXY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_rds_proxy","required":true},{"id":"proxy_name","label":"Proxy Name","type":"text","default":"my-rds-proxy","required":true},{"id":"engine_family","label":"Engine Family","type":"select","options":["MYSQL","POSTGRESQL"],"default":"POSTGRESQL"},{"id":"target_db_identifier","label":"Target RDS Identifier","type":"text","default":"aws_db_instance.my_rds.identifier"},{"id":"secret_arn","label":"Secrets Manager ARN (DB creds)","type":"text","default":"aws_secretsmanager_secret.db.arn"}]',
  'resource "aws_db_proxy" "{{name}}" {
  name                   = "{{proxy_name}}"
  debug_logging          = false
  engine_family          = "{{engine_family}}"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = aws_iam_role.{{name}}_proxy.arn
  vpc_subnet_ids         = [aws_subnet.private_a.id]

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = {{secret_arn}}
  }

  tags = {
    Name      = "{{proxy_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_db_proxy_target" "{{name}}" {
  db_proxy_name          = aws_db_proxy.{{name}}.name
  target_group_name      = "default"
  db_instance_identifier = {{target_db_identifier}}
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'timestream_database', 'Timestream Database', 'Database', 'TS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_timestream","required":true},{"id":"db_name","label":"Database Name","type":"text","default":"my-metrics-db","required":true},{"id":"table_name","label":"Table Name","type":"text","default":"metrics","required":true},{"id":"memory_retention_hours","label":"Memory Retention (hours)","type":"number","default":"24"},{"id":"magnetic_retention_days","label":"Magnetic Retention (days)","type":"number","default":"365"}]',
  'resource "aws_timestreamwrite_database" "{{name}}" {
  database_name = "{{db_name}}"

  tags = {
    Name      = "{{db_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_timestreamwrite_table" "{{name}}" {
  database_name = aws_timestreamwrite_database.{{name}}.database_name
  table_name    = "{{table_name}}"

  retention_properties {
    magnetic_store_retention_period_in_days = {{magnetic_retention_days}}
    memory_store_retention_period_in_hours  = {{memory_retention_hours}}
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- IAM & SECURITY – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'acm_certificate', 'ACM Certificate', 'IAM & Security', 'ACM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cert","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"example.com","required":true},{"id":"validation_method","label":"Validation Method","type":"select","options":["DNS","EMAIL"],"default":"DNS"},{"id":"subject_alternative_names","label":"SANs (comma-sep, optional)","type":"text","default":"*.example.com"}]',
  'resource "aws_acm_certificate" "{{name}}" {
  domain_name               = "{{domain_name}}"
  validation_method         = "{{validation_method}}"
  subject_alternative_names = ["{{subject_alternative_names}}"]

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_acm_certificate_validation" "{{name}}" {
  certificate_arn = aws_acm_certificate.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'security_hub', 'Security Hub', 'IAM & Security', 'SHUB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_security_hub","required":true},{"id":"enable_default_standards","label":"Enable Default Standards","type":"select","options":["true","false"],"default":"true"},{"id":"cis_standard","label":"Enable CIS AWS Benchmark","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_securityhub_account" "{{name}}" {
  enable_default_standards = {{enable_default_standards}}
}

resource "aws_securityhub_standards_subscription" "cis" {
  count         = {{cis_standard}} ? 1 : 0
  standards_arn = "arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0"
  depends_on    = [aws_securityhub_account.{{name}}]
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'macie', 'Amazon Macie', 'IAM & Security', 'MAC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_macie","required":true},{"id":"finding_frequency","label":"Finding Frequency","type":"select","options":["FIFTEEN_MINUTES","ONE_HOUR","SIX_HOURS"],"default":"ONE_HOUR"},{"id":"status","label":"Status","type":"select","options":["ENABLED","PAUSED"],"default":"ENABLED"}]',
  'resource "aws_macie2_account" "{{name}}" {
  finding_publishing_frequency = "{{finding_frequency}}"
  status                       = "{{status}}"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'inspector2', 'AWS Inspector v2', 'IAM & Security', 'INSP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_inspector","required":true},{"id":"scan_type","label":"Scan Types","type":"select","options":["EC2","ECR","LAMBDA","LAMBDA_CODE"],"default":"EC2"}]',
  'resource "aws_inspector2_enabler" "{{name}}" {
  account_ids = [data.aws_caller_identity.current.account_id]
  resource_types = ["{{scan_type}}"]
}

data "aws_caller_identity" "current" {}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_oidc_provider', 'IAM OIDC Provider', 'IAM & Security', 'OIDC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_oidc","required":true},{"id":"url","label":"Provider URL","type":"text","default":"https://token.actions.githubusercontent.com","required":true},{"id":"client_id_list","label":"Client ID List (comma-sep)","type":"text","default":"sts.amazonaws.com"}]',
  'resource "aws_iam_openid_connect_provider" "{{name}}" {
  url             = "{{url}}"
  client_id_list  = ["{{client_id_list}}"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- MONITORING – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_dashboard', 'CloudWatch Dashboard', 'Monitoring', 'DASH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_dashboard","required":true},{"id":"dashboard_name","label":"Dashboard Name","type":"text","default":"MyApplicationDashboard","required":true}]',
  'resource "aws_cloudwatch_dashboard" "{{name}}" {
  dashboard_name = "{{dashboard_name}}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric"
        properties = {
          title  = "CPU Utilization"
          period = 300
          stat   = "Average"
          metrics = [["AWS/EC2", "CPUUtilization"]]
        }
      }
    ]
  })
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'xray_group', 'X-Ray Group', 'Monitoring', 'XRAY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_xray_group","required":true},{"id":"group_name","label":"Group Name","type":"text","default":"my-service-group","required":true},{"id":"filter_expression","label":"Filter Expression","type":"text","default":"service(\"my-service\")"},{"id":"insights_enabled","label":"Insights Enabled","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_xray_group" "{{name}}" {
  group_name        = "{{group_name}}"
  filter_expression = "{{filter_expression}}"

  insights_configuration {
    insights_enabled      = {{insights_enabled}}
    notifications_enabled = {{insights_enabled}}
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'prometheus_workspace', 'Amazon Managed Prometheus', 'Monitoring', 'AMP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_amp","required":true},{"id":"alias","label":"Workspace Alias","type":"text","default":"my-prometheus","required":true},{"id":"retention_days","label":"Retention (days)","type":"number","default":"150"}]',
  'resource "aws_prometheus_workspace" "{{name}}" {
  alias = "{{alias}}"

  logging_configuration {
    log_group_arn = "${aws_cloudwatch_log_group.{{name}}.arn}:*"
  }

  tags = {
    Name      = "{{alias}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'grafana_workspace', 'Amazon Managed Grafana', 'Monitoring', 'AMG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_grafana","required":true},{"id":"workspace_name","label":"Workspace Name","type":"text","default":"my-grafana","required":true},{"id":"account_access_type","label":"Account Access","type":"select","options":["CURRENT_ACCOUNT","ORGANIZATION"],"default":"CURRENT_ACCOUNT"},{"id":"authentication_providers","label":"Auth Provider","type":"select","options":["AWS_SSO","SAML"],"default":"AWS_SSO"}]',
  'resource "aws_grafana_workspace" "{{name}}" {
  name                  = "{{workspace_name}}"
  account_access_type   = "{{account_access_type}}"
  authentication_providers = ["{{authentication_providers}}"]
  permission_type       = "SERVICE_MANAGED"
  role_arn              = aws_iam_role.{{name}}_grafana.arn

  tags = {
    Name      = "{{workspace_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTAINERS – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecs_task_definition', 'ECS Task Definition', 'Containers', 'TASK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_task","required":true},{"id":"family","label":"Task Family Name","type":"text","default":"my-app-task","required":true},{"id":"cpu","label":"CPU (vCPU units)","type":"select","options":["256","512","1024","2048","4096"],"default":"256"},{"id":"memory","label":"Memory (MB)","type":"select","options":["512","1024","2048","4096","8192"],"default":"512"},{"id":"container_image","label":"Container Image URI","type":"text","default":"nginx:latest"},{"id":"container_port","label":"Container Port","type":"number","default":"80"},{"id":"network_mode","label":"Network Mode","type":"select","options":["awsvpc","bridge","host"],"default":"awsvpc"}]',
  'resource "aws_ecs_task_definition" "{{name}}" {
  family                   = "{{family}}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "{{network_mode}}"
  cpu                      = "{{cpu}}"
  memory                   = "{{memory}}"
  execution_role_arn       = aws_iam_role.{{name}}_exec.arn
  task_role_arn            = aws_iam_role.{{name}}_task.arn

  container_definitions = jsonencode([
    {
      name      = "{{family}}"
      image     = "{{container_image}}"
      essential = true
      portMappings = [
        { containerPort = {{container_port}}, protocol = "tcp" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = "/ecs/{{family}}"
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = {
    Name      = "{{family}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecs_service', 'ECS Service', 'Containers', 'SVC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ecs_svc","required":true},{"id":"service_name","label":"Service Name","type":"text","default":"my-app-service","required":true},{"id":"cluster_arn","label":"Cluster ARN / Reference","type":"text","default":"aws_ecs_cluster.my_ecs.arn","required":true},{"id":"task_definition_arn","label":"Task Definition ARN / Ref","type":"text","default":"aws_ecs_task_definition.my_task.arn","required":true},{"id":"desired_count","label":"Desired Count","type":"number","default":"2"},{"id":"launch_type","label":"Launch Type","type":"select","options":["FARGATE","EC2"],"default":"FARGATE"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"},{"id":"security_group_ids","label":"Security Group IDs","type":"text","default":"aws_security_group.app_sg.id"},{"id":"target_group_arn","label":"ALB Target Group ARN (optional)","type":"text","default":""}]',
  'resource "aws_ecs_service" "{{name}}" {
  name            = "{{service_name}}"
  cluster         = {{cluster_arn}}
  task_definition = {{task_definition_arn}}
  desired_count   = {{desired_count}}
  launch_type     = "{{launch_type}}"

  network_configuration {
    subnets          = [{{subnet_ids}}]
    security_groups  = [{{security_group_ids}}]
    assign_public_ip = false
  }

  deployment_controller { type = "ECS" }

  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = {
    Name      = "{{service_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eks_node_group', 'EKS Managed Node Group', 'Containers', 'NG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ng","required":true},{"id":"cluster_name","label":"EKS Cluster Name / Ref","type":"text","default":"aws_eks_cluster.my_eks.name","required":true},{"id":"node_group_name","label":"Node Group Name","type":"text","default":"my-node-group","required":true},{"id":"instance_types","label":"Instance Types","type":"select","options":["t3.medium","t3.large","m5.large","m5.xlarge","c5.large"],"default":"t3.medium"},{"id":"min_size","label":"Min Nodes","type":"number","default":"2"},{"id":"max_size","label":"Max Nodes","type":"number","default":"6"},{"id":"desired_size","label":"Desired Nodes","type":"number","default":"2"},{"id":"disk_size","label":"Disk Size (GB)","type":"number","default":"50"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_eks_node_group" "{{name}}" {
  cluster_name    = {{cluster_name}}
  node_group_name = "{{node_group_name}}"
  node_role_arn   = aws_iam_role.{{name}}_nodes.arn
  subnet_ids      = [{{subnet_ids}}]
  instance_types  = ["{{instance_types}}"]
  disk_size       = {{disk_size}}

  scaling_config {
    desired_size = {{desired_size}}
    max_size     = {{max_size}}
    min_size     = {{min_size}}
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "{{node_group_name}}"
  }

  tags = {
    Name      = "{{node_group_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eks_fargate_profile', 'EKS Fargate Profile', 'Containers', 'FG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_fargate_profile","required":true},{"id":"cluster_name","label":"EKS Cluster Name / Ref","type":"text","default":"aws_eks_cluster.my_eks.name","required":true},{"id":"profile_name","label":"Profile Name","type":"text","default":"my-fargate-profile","required":true},{"id":"namespace","label":"Kubernetes Namespace","type":"text","default":"default"},{"id":"subnet_ids","label":"Private Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_eks_fargate_profile" "{{name}}" {
  cluster_name           = {{cluster_name}}
  fargate_profile_name   = "{{profile_name}}"
  pod_execution_role_arn = aws_iam_role.{{name}}_fargate.arn
  subnet_ids             = [{{subnet_ids}}]

  selector {
    namespace = "{{namespace}}"
  }

  tags = {
    Name      = "{{profile_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CI/CD – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codecommit', 'CodeCommit Repository', 'CI/CD', 'GIT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_repo","required":true},{"id":"repository_name","label":"Repository Name","type":"text","default":"my-app-repo","required":true},{"id":"description","label":"Description","type":"text","default":"Application source code repository"}]',
  'resource "aws_codecommit_repository" "{{name}}" {
  repository_name = "{{repository_name}}"
  description     = "{{description}}"

  tags = {
    Name      = "{{repository_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codeartifact', 'CodeArtifact Domain', 'CI/CD', 'PKG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_artifact","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"my-domain","required":true},{"id":"repository_name","label":"Repository Name","type":"text","default":"my-packages","required":true},{"id":"package_format","label":"Package Format","type":"select","options":["npm","pypi","maven","nuget","generic"],"default":"npm"},{"id":"upstream_name","label":"Upstream Repository (optional)","type":"text","default":""}]',
  'resource "aws_codeartifact_domain" "{{name}}" {
  domain = "{{domain_name}}"

  tags = {
    Name      = "{{domain_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_codeartifact_repository" "{{name}}" {
  repository = "{{repository_name}}"
  domain     = aws_codeartifact_domain.{{name}}.domain
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'api_gateway_v2', 'API Gateway HTTP (v2)', 'CI/CD', 'HTTP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_http_api","required":true},{"id":"api_name","label":"API Name","type":"text","default":"my-http-api","required":true},{"id":"protocol_type","label":"Protocol","type":"select","options":["HTTP","WEBSOCKET"],"default":"HTTP"},{"id":"stage_name","label":"Stage Name","type":"text","default":"$default"},{"id":"lambda_arn","label":"Lambda Function ARN","type":"text","default":"aws_lambda_function.my_fn.invoke_arn"},{"id":"cors_allow_origins","label":"CORS Allow Origins","type":"text","default":"*"}]',
  'resource "aws_apigatewayv2_api" "{{name}}" {
  name          = "{{api_name}}"
  protocol_type = "{{protocol_type}}"

  cors_configuration {
    allow_origins = ["{{cors_allow_origins}}"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
  }

  tags = {
    Name      = "{{api_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_apigatewayv2_integration" "{{name}}" {
  api_id             = aws_apigatewayv2_api.{{name}}.id
  integration_type   = "AWS_PROXY"
  integration_uri    = {{lambda_arn}}
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_stage" "{{name}}" {
  api_id      = aws_apigatewayv2_api.{{name}}.id
  name        = "{{stage_name}}"
  auto_deploy = true
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'amplify_app', 'Amplify App', 'CI/CD', 'AMP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_amplify","required":true},{"id":"app_name","label":"App Name","type":"text","default":"my-web-app","required":true},{"id":"repository","label":"Git Repository URL","type":"text","default":"https://github.com/my-org/my-repo","required":true},{"id":"branch_name","label":"Branch Name","type":"text","default":"main"},{"id":"framework","label":"Framework","type":"select","options":["React","Vue","Angular","Next.js","Nuxt.js","Gatsby","Hugo","None"],"default":"React"}]',
  'resource "aws_amplify_app" "{{name}}" {
  name       = "{{app_name}}"
  repository = "{{repository}}"

  build_spec = <<-EOT
    version: 1
    frontend:
      phases:
        preBuild:
          commands: [npm install]
        build:
          commands: [npm run build]
      artifacts:
        baseDirectory: build
        files: ["**/*"]
      cache:
        paths: [node_modules/**/*]
  EOT

  tags = {
    Name      = "{{app_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_amplify_branch" "{{name}}" {
  app_id      = aws_amplify_app.{{name}}.id
  branch_name = "{{branch_name}}"
  framework   = "{{framework}}"
  stage       = "PRODUCTION"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS (NEW CATEGORY)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'kinesis_stream', 'Kinesis Data Stream', 'Analytics', 'KDS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_stream","required":true},{"id":"stream_name","label":"Stream Name","type":"text","default":"my-data-stream","required":true},{"id":"shard_count","label":"Shard Count","type":"number","default":"1"},{"id":"retention_period","label":"Retention Period (hours)","type":"number","default":"24"},{"id":"stream_mode","label":"Stream Mode","type":"select","options":["PROVISIONED","ON_DEMAND"],"default":"PROVISIONED"}]',
  'resource "aws_kinesis_stream" "{{name}}" {
  name             = "{{stream_name}}"
  shard_count      = {{shard_count}}
  retention_period = {{retention_period}}

  stream_mode_details {
    stream_mode = "{{stream_mode}}"
  }

  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"

  tags = {
    Name      = "{{stream_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'kinesis_firehose', 'Kinesis Firehose', 'Analytics', 'KDF',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_firehose","required":true},{"id":"stream_name","label":"Delivery Stream Name","type":"text","default":"my-firehose","required":true},{"id":"destination","label":"Destination","type":"select","options":["extended_s3","opensearch","splunk","redshift"],"default":"extended_s3"},{"id":"s3_bucket_arn","label":"S3 Bucket ARN","type":"text","default":"aws_s3_bucket.my_bucket.arn","required":true},{"id":"buffer_interval","label":"Buffer Interval (seconds)","type":"number","default":"300"},{"id":"buffer_size","label":"Buffer Size (MB)","type":"number","default":"5"}]',
  'resource "aws_kinesis_firehose_delivery_stream" "{{name}}" {
  name        = "{{stream_name}}"
  destination = "{{destination}}"

  extended_s3_configuration {
    role_arn           = aws_iam_role.{{name}}_firehose.arn
    bucket_arn         = {{s3_bucket_arn}}
    buffering_interval = {{buffer_interval}}
    buffering_size     = {{buffer_size}}
    prefix             = "data/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"
    compression_format = "GZIP"
  }

  tags = {
    Name      = "{{stream_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'glue_job', 'AWS Glue ETL Job', 'Analytics', 'GLU',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_glue_job","required":true},{"id":"job_name","label":"Job Name","type":"text","default":"my-etl-job","required":true},{"id":"glue_version","label":"Glue Version","type":"select","options":["4.0","3.0","2.0"],"default":"4.0"},{"id":"worker_type","label":"Worker Type","type":"select","options":["G.1X","G.2X","G.4X","G.8X","Standard"],"default":"G.1X"},{"id":"number_of_workers","label":"Number of Workers","type":"number","default":"2"},{"id":"script_bucket","label":"Script S3 Bucket","type":"text","default":"my-scripts-bucket"},{"id":"script_key","label":"Script S3 Key","type":"text","default":"scripts/my-etl.py"}]',
  'resource "aws_glue_job" "{{name}}" {
  name         = "{{job_name}}"
  role_arn     = aws_iam_role.{{name}}_glue.arn
  glue_version = "{{glue_version}}"
  worker_type  = "{{worker_type}}"
  number_of_workers = {{number_of_workers}}

  command {
    name            = "glueetl"
    script_location = "s3://{{script_bucket}}/{{script_key}}"
    python_version  = "3"
  }

  default_arguments = {
    "--job-bookmark-option"   = "job-bookmark-enable"
    "--enable-metrics"        = ""
    "--enable-spark-ui"       = "true"
  }

  tags = {
    Name      = "{{job_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'glue_catalog_database', 'Glue Catalog Database', 'Analytics', 'CAT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_glue_db","required":true},{"id":"db_name","label":"Database Name","type":"text","default":"my_data_lake","required":true},{"id":"description","label":"Description","type":"text","default":"Data Lake catalog database"},{"id":"location_uri","label":"S3 Location URI","type":"text","default":"s3://my-datalake-bucket/"}]',
  'resource "aws_glue_catalog_database" "{{name}}" {
  name        = "{{db_name}}"
  description = "{{description}}"

  location_uri = "{{location_uri}}"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'athena_workgroup', 'Athena Workgroup', 'Analytics', 'ATH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_athena","required":true},{"id":"workgroup_name","label":"Workgroup Name","type":"text","default":"my-analytics-workgroup","required":true},{"id":"output_bucket","label":"Output S3 Bucket","type":"text","default":"s3://my-athena-results/","required":true},{"id":"enforce_workgroup_config","label":"Enforce Workgroup Config","type":"select","options":["true","false"],"default":"true"},{"id":"bytes_scanned_cutoff","label":"Data Scanned Limit (bytes, 0=no limit)","type":"number","default":"0"}]',
  'resource "aws_athena_workgroup" "{{name}}" {
  name = "{{workgroup_name}}"

  configuration {
    enforce_workgroup_configuration    = {{enforce_workgroup_config}}
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "{{output_bucket}}"

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }

  tags = {
    Name      = "{{workgroup_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'msk_cluster', 'MSK Kafka Cluster', 'Analytics', 'MSK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_msk","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-kafka-cluster","required":true},{"id":"kafka_version","label":"Kafka Version","type":"select","options":["3.6.0","3.5.1","3.4.0","3.3.2","2.8.2"],"default":"3.6.0"},{"id":"broker_instance_type","label":"Broker Instance Type","type":"select","options":["kafka.t3.small","kafka.m5.large","kafka.m5.xlarge","kafka.m5.2xlarge"],"default":"kafka.m5.large"},{"id":"broker_count","label":"Brokers per AZ","type":"number","default":"1"},{"id":"ebs_volume_size","label":"EBS Volume Size (GB)","type":"number","default":"100"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep, 3 for HA)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_msk_cluster" "{{name}}" {
  cluster_name           = "{{cluster_name}}"
  kafka_version          = "{{kafka_version}}"
  number_of_broker_nodes = {{broker_count}}

  broker_node_group_info {
    instance_type = "{{broker_instance_type}}"
    client_subnets = [{{subnet_ids}}]
    storage_info {
      ebs_storage_info { volume_size = {{ebs_volume_size}} }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  tags = {
    Name      = "{{cluster_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'emr_cluster', 'EMR Cluster', 'Analytics', 'EMR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_emr","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-emr-cluster","required":true},{"id":"release_label","label":"EMR Release","type":"select","options":["emr-7.2.0","emr-7.1.0","emr-6.15.0","emr-6.14.0"],"default":"emr-7.2.0"},{"id":"master_instance_type","label":"Master Instance Type","type":"select","options":["m5.xlarge","m5.2xlarge","m6g.xlarge"],"default":"m5.xlarge"},{"id":"core_instance_type","label":"Core Instance Type","type":"select","options":["m5.xlarge","m5.2xlarge","r5.xlarge"],"default":"m5.xlarge"},{"id":"core_instance_count","label":"Core Instance Count","type":"number","default":"2"},{"id":"log_bucket","label":"Log S3 Bucket","type":"text","default":"s3://my-emr-logs/"}]',
  'resource "aws_emr_cluster" "{{name}}" {
  name          = "{{cluster_name}}"
  release_label = "{{release_label}}"
  applications  = ["Spark", "Hadoop", "Hive"]
  log_uri       = "{{log_bucket}}"

  service_role = aws_iam_role.{{name}}_emr.arn

  master_instance_group {
    instance_type = "{{master_instance_type}}"
  }

  core_instance_group {
    instance_type  = "{{core_instance_type}}"
    instance_count = {{core_instance_count}}
  }

  tags = {
    Name      = "{{cluster_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- APP INTEGRATION (NEW CATEGORY)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'step_functions', 'Step Functions State Machine', 'App Integration', 'SFN',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sfn","required":true},{"id":"state_machine_name","label":"State Machine Name","type":"text","default":"my-workflow","required":true},{"id":"type","label":"Type","type":"select","options":["STANDARD","EXPRESS"],"default":"STANDARD"},{"id":"log_level","label":"Log Level","type":"select","options":["OFF","ERROR","FATAL","ALL"],"default":"ERROR"}]',
  'resource "aws_sfn_state_machine" "{{name}}" {
  name     = "{{state_machine_name}}"
  role_arn = aws_iam_role.{{name}}_sfn.arn
  type     = "{{type}}"

  definition = jsonencode({
    Comment = "{{state_machine_name}} workflow"
    StartAt = "HelloWorld"
    States = {
      HelloWorld = {
        Type = "Pass"
        Result = "Hello World!"
        End = true
      }
    }
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.{{name}}.arn}:*"
    include_execution_data = true
    level                  = "{{log_level}}"
  }

  tags = {
    Name      = "{{state_machine_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'appsync', 'AppSync GraphQL API', 'App Integration', 'GQL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_appsync","required":true},{"id":"api_name","label":"API Name","type":"text","default":"my-graphql-api","required":true},{"id":"authentication_type","label":"Auth Type","type":"select","options":["API_KEY","AWS_IAM","AMAZON_COGNITO_USER_POOLS","OPENID_CONNECT"],"default":"API_KEY"},{"id":"log_field_log_level","label":"Log Level","type":"select","options":["NONE","ERROR","ALL"],"default":"ERROR"}]',
  'resource "aws_appsync_graphql_api" "{{name}}" {
  name                = "{{api_name}}"
  authentication_type = "{{authentication_type}}"

  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.{{name}}_appsync.arn
    field_log_level          = "{{log_field_log_level}}"
  }

  tags = {
    Name      = "{{api_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_appsync_api_key" "{{name}}" {
  api_id  = aws_appsync_graphql_api.{{name}}.id
  expires = timeadd(timestamp(), "8760h")
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'mq_broker', 'Amazon MQ Broker', 'App Integration', 'MQ',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_mq","required":true},{"id":"broker_name","label":"Broker Name","type":"text","default":"my-message-broker","required":true},{"id":"engine_type","label":"Engine Type","type":"select","options":["ActiveMQ","RabbitMQ"],"default":"RabbitMQ"},{"id":"engine_version","label":"Engine Version","type":"text","default":"3.11.20"},{"id":"host_instance_type","label":"Instance Type","type":"select","options":["mq.t3.micro","mq.m5.large","mq.m5.xlarge"],"default":"mq.m5.large"},{"id":"deployment_mode","label":"Deployment Mode","type":"select","options":["SINGLE_INSTANCE","ACTIVE_STANDBY_MULTI_AZ","CLUSTER_MULTI_AZ"],"default":"SINGLE_INSTANCE"},{"id":"publicly_accessible","label":"Publicly Accessible","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_mq_broker" "{{name}}" {
  broker_name         = "{{broker_name}}"
  engine_type         = "{{engine_type}}"
  engine_version      = "{{engine_version}}"
  host_instance_type  = "{{host_instance_type}}"
  deployment_mode     = "{{deployment_mode}}"
  publicly_accessible = {{publicly_accessible}}

  user {
    username = "admin"
    password = var.mq_password
  }

  tags = {
    Name      = "{{broker_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eventbridge_bus', 'EventBridge Event Bus', 'App Integration', 'BUS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_event_bus","required":true},{"id":"bus_name","label":"Event Bus Name","type":"text","default":"my-custom-events","required":true}]',
  'resource "aws_cloudwatch_event_bus" "{{name}}" {
  name = "{{bus_name}}"

  tags = {
    Name      = "{{bus_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cognito_user_pool', 'Cognito User Pool', 'App Integration', 'AUTH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cognito","required":true},{"id":"pool_name","label":"User Pool Name","type":"text","default":"my-user-pool","required":true},{"id":"mfa_configuration","label":"MFA","type":"select","options":["OFF","OPTIONAL","ON"],"default":"OPTIONAL"},{"id":"password_min_length","label":"Min Password Length","type":"number","default":"8"},{"id":"auto_verified_attributes","label":"Auto Verify","type":"select","options":["email","phone_number"],"default":"email"}]',
  'resource "aws_cognito_user_pool" "{{name}}" {
  name = "{{pool_name}}"
  mfa_configuration = "{{mfa_configuration}}"
  auto_verified_attributes = ["{{auto_verified_attributes}}"]

  password_policy {
    minimum_length    = {{password_min_length}}
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = {
    Name      = "{{pool_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- MACHINE LEARNING (NEW CATEGORY)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sagemaker_notebook', 'SageMaker Notebook', 'Machine Learning', 'NB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_notebook","required":true},{"id":"notebook_name","label":"Notebook Instance Name","type":"text","default":"my-notebook","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["ml.t3.medium","ml.t3.large","ml.t3.xlarge","ml.m5.large","ml.m5.xlarge","ml.p3.2xlarge","ml.g4dn.xlarge"],"default":"ml.t3.medium"},{"id":"volume_size","label":"Volume Size (GB)","type":"number","default":"50"}]',
  'resource "aws_sagemaker_notebook_instance" "{{name}}" {
  name          = "{{notebook_name}}"
  instance_type = "{{instance_type}}"
  role_arn      = aws_iam_role.{{name}}_sm.arn
  volume_size   = {{volume_size}}

  tags = {
    Name      = "{{notebook_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sagemaker_endpoint', 'SageMaker Endpoint', 'Machine Learning', 'ML',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sm_endpoint","required":true},{"id":"endpoint_name","label":"Endpoint Name","type":"text","default":"my-model-endpoint","required":true},{"id":"model_name","label":"Model Name","type":"text","default":"my-model","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["ml.t2.medium","ml.t3.medium","ml.m5.large","ml.c5.xlarge","ml.g4dn.xlarge","ml.g5.xlarge"],"default":"ml.m5.large"},{"id":"initial_instance_count","label":"Initial Instance Count","type":"number","default":"1"}]',
  'resource "aws_sagemaker_endpoint_configuration" "{{name}}" {
  name = "{{endpoint_name}}-config"

  production_variants {
    variant_name           = "primary"
    model_name             = "{{model_name}}"
    initial_instance_count = {{initial_instance_count}}
    instance_type          = "{{instance_type}}"
  }

  tags = {
    Name      = "{{endpoint_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_sagemaker_endpoint" "{{name}}" {
  name                 = "{{endpoint_name}}"
  endpoint_config_name = aws_sagemaker_endpoint_configuration.{{name}}.name

  tags = {
    Name      = "{{endpoint_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'bedrock_model_invocation', 'Bedrock Model Invocation Logging', 'Machine Learning', 'BDK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_bedrock_log","required":true},{"id":"log_bucket","label":"S3 Bucket for Logs","type":"text","default":"aws_s3_bucket.bedrock_logs.id","required":true},{"id":"embedding_model_enabled","label":"Log Embedding Models","type":"select","options":["true","false"],"default":"true"},{"id":"text_model_enabled","label":"Log Text Models","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_bedrock_model_invocation_logging_configuration" "{{name}}" {
  logging_config {
    embedding_data_delivery_enabled = {{embedding_model_enabled}}
    text_data_delivery_enabled      = {{text_model_enabled}}
    image_data_delivery_enabled     = false

    s3_config {
      bucket_name = {{log_bucket}}
      key_prefix  = "bedrock-logs/"
    }
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN & OPS – additional
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ssm_patch_baseline', 'SSM Patch Baseline', 'Admin & Ops', 'PTCH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_patch_baseline","required":true},{"id":"baseline_name","label":"Baseline Name","type":"text","default":"my-patch-baseline","required":true},{"id":"operating_system","label":"Operating System","type":"select","options":["AMAZON_LINUX_2","AMAZON_LINUX_2023","UBUNTU","WINDOWS","REDHAT_ENTERPRISE_LINUX"],"default":"AMAZON_LINUX_2"},{"id":"patch_filter_key","label":"Patch Classification","type":"select","options":["Security","Bugfix","Enhancement","Recommended"],"default":"Security"},{"id":"approval_delay","label":"Approval Delay (days)","type":"number","default":"7"}]',
  'resource "aws_ssm_patch_baseline" "{{name}}" {
  name             = "{{baseline_name}}"
  operating_system = "{{operating_system}}"
  description      = "{{baseline_name}} patch baseline"

  approval_rule {
    approve_after_days = {{approval_delay}}
    patch_filter {
      key    = "CLASSIFICATION"
      values = ["{{patch_filter_key}}"]
    }
  }

  tags = {
    Name      = "{{baseline_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ses_email_identity', 'SES Email Identity', 'Admin & Ops', 'SES',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ses","required":true},{"id":"email_identity","label":"Email or Domain","type":"text","default":"mail.example.com","required":true},{"id":"dkim_enabled","label":"Enable DKIM Signing","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_sesv2_email_identity" "{{name}}" {
  email_identity = "{{email_identity}}"

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = {
    Name      = "{{email_identity}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'organizations_account', 'AWS Organizations Account', 'Admin & Ops', 'ORG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_org_account","required":true},{"id":"account_name","label":"Account Name","type":"text","default":"my-team-account","required":true},{"id":"email","label":"Account Email","type":"text","default":"aws-team@example.com","required":true},{"id":"parent_id","label":"OU or Root ID","type":"text","default":"aws_organizations_organizational_unit.my_ou.id"},{"id":"role_name","label":"IAM Role Name","type":"text","default":"OrganizationAccountAccessRole"}]',
  'resource "aws_organizations_account" "{{name}}" {
  name      = "{{account_name}}"
  email     = "{{email}}"
  parent_id = {{parent_id}}
  role_name = "{{role_name}}"

  tags = {
    Name      = "{{account_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'service_control_policy', 'Service Control Policy (SCP)', 'Admin & Ops', 'SCP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_scp","required":true},{"id":"policy_name","label":"Policy Name","type":"text","default":"deny-root-access","required":true},{"id":"description","label":"Description","type":"text","default":"Prevent root account usage"}]',
  'resource "aws_organizations_policy" "{{name}}" {
  name        = "{{policy_name}}"
  description = "{{description}}"
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyRootAccess"
        Effect   = "Deny"
        Action   = "*"
        Resource = "*"
        Condition = {
          StringLike = {
            "aws:PrincipalArn" = ["arn:aws:iam::*:root"]
          }
        }
      }
    ]
  })

  tags = {
    Name      = "{{policy_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'config_conformance_pack', 'Config Conformance Pack', 'Admin & Ops', 'CONF',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_conformance_pack","required":true},{"id":"pack_name","label":"Pack Name","type":"text","default":"operational-best-practices","required":true},{"id":"s3_bucket","label":"Template S3 Bucket (optional)","type":"text","default":""}]',
  'resource "aws_config_conformance_pack" "{{name}}" {
  name = "{{pack_name}}"

  template_body = <<-EOT
    Parameters:
      AccessKeysRotatedParameterMaxAccessKeyAge:
        Type: String
        Default: "90"
    Resources:
      AWSConfigRuleForAccessKeysRotated:
        Type: AWS::Config::ConfigRule
        Properties:
          ConfigRuleName: access-keys-rotated
          Source:
            Owner: AWS
            SourceIdentifier: ACCESS_KEYS_ROTATED
  EOT
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ssm_maintenance_window', 'SSM Maintenance Window', 'Admin & Ops', 'MW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_mw","required":true},{"id":"window_name","label":"Window Name","type":"text","default":"weekly-patching","required":true},{"id":"schedule","label":"Schedule (cron/rate)","type":"text","default":"cron(0 2 ? * SUN *)"},{"id":"duration","label":"Duration (hours)","type":"number","default":"4"},{"id":"cutoff","label":"Cutoff (hours before end)","type":"number","default":"1"},{"id":"allow_unassociated_targets","label":"Allow Unassociated Targets","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_ssm_maintenance_window" "{{name}}" {
  name                       = "{{window_name}}"
  schedule                   = "{{schedule}}"
  duration                   = {{duration}}
  cutoff                     = {{cutoff}}
  allow_unassociated_targets = {{allow_unassociated_targets}}

  tags = {
    Name      = "{{window_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'route53_health_check', 'Route53 Health Check', 'Admin & Ops', 'HC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_health_check","required":true},{"id":"fqdn","label":"Domain / FQDN","type":"text","default":"api.example.com","required":true},{"id":"port","label":"Port","type":"number","default":"443"},{"id":"type","label":"Type","type":"select","options":["HTTPS","HTTP","TCP","HTTPS_STR_MATCH","HTTP_STR_MATCH"],"default":"HTTPS"},{"id":"resource_path","label":"Resource Path","type":"text","default":"/health"},{"id":"failure_threshold","label":"Failure Threshold","type":"number","default":"3"},{"id":"request_interval","label":"Request Interval (seconds)","type":"select","options":["10","30"],"default":"30"}]',
  'resource "aws_route53_health_check" "{{name}}" {
  fqdn              = "{{fqdn}}"
  port              = {{port}}
  type              = "{{type}}"
  resource_path     = "{{resource_path}}"
  failure_threshold = {{failure_threshold}}
  request_interval  = {{request_interval}}

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;
