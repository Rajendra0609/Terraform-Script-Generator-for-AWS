-- =============================================================================
-- Terraform Script Generator — Full AWS Service Seed
-- Aligned with AWS Cloud Learning Roadmap (DevOps + Admin paths)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- COMPUTE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ec2', 'EC2 Instance', 'Compute', 'SERVER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ec2","required":true},{"id":"ami_id","label":"AMI ID","type":"text","default":"ami-0c55b159cbfafe1f0","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["t2.micro","t2.small","t2.medium","t3.nano","t3.micro","t3.small","t3.medium","t3.large","t3.xlarge","m5.large","m5.xlarge","c5.large","c5.xlarge","r5.large"],"default":"t3.micro"},{"id":"key_name","label":"Key Pair Name","type":"text","default":"my-key-pair"},{"id":"subnet_id","label":"Subnet ID / Reference","type":"text","default":""},{"id":"vpc_security_group_ids","label":"Security Group IDs (comma-sep)","type":"text","default":""},{"id":"associate_public_ip","label":"Associate Public IP","type":"select","options":["true","false"],"default":"true"},{"id":"volume_size","label":"Root Volume Size (GB)","type":"number","default":"20"},{"id":"volume_type","label":"Volume Type","type":"select","options":["gp3","gp2","io1","io2"],"default":"gp3"}]',
  'resource "aws_instance" "{{name}}" {\n  ami                         = "{{ami_id}}"\n  instance_type               = "{{instance_type}}"\n  key_name                    = "{{key_name}}"\n  subnet_id                   = "{{subnet_id}}"\n  associate_public_ip_address = {{associate_public_ip}}\n\n  root_block_device {\n    volume_size = {{volume_size}}\n    volume_type = "{{volume_type}}"\n    encrypted   = true\n  }\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  'module "{{name}}" {\n  source        = "terraform-aws-modules/ec2-instance/aws"\n  version       = "~> 5.0"\n\n  name          = "{{name}}"\n  ami           = "{{ami_id}}"\n  instance_type = "{{instance_type}}"\n  key_name      = "{{key_name}}"\n  subnet_id     = "{{subnet_id}}"\n\n  root_block_device = [{\n    volume_size = {{volume_size}}\n    volume_type = "{{volume_type}}"\n    encrypted   = true\n  }]\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'auto_scaling_group', 'Auto Scaling Group', 'Compute', 'AUTOSCALE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_asg","required":true},{"id":"ami_id","label":"AMI ID","type":"text","default":"ami-0c55b159cbfafe1f0","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["t3.micro","t3.small","t3.medium","t3.large","m5.large"],"default":"t3.micro"},{"id":"min_size","label":"Min Instances","type":"number","default":"1"},{"id":"max_size","label":"Max Instances","type":"number","default":"4"},{"id":"desired_capacity","label":"Desired Capacity","type":"number","default":"2"},{"id":"vpc_zone_identifier","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.public.id"},{"id":"target_group_arns","label":"ALB Target Group ARN","type":"text","default":""}]',
  'resource "aws_launch_template" "{{name}}" {\n  name_prefix   = "{{name}}-lt-"\n  image_id      = "{{ami_id}}"\n  instance_type = "{{instance_type}}"\n\n  tag_specifications {\n    resource_type = "instance"\n    tags = {\n      Name      = "{{name}}"\n      ManagedBy = "Terraform"\n    }\n  }\n}\n\nresource "aws_autoscaling_group" "{{name}}" {\n  name                = "{{name}}-asg"\n  min_size            = {{min_size}}\n  max_size            = {{max_size}}\n  desired_capacity    = {{desired_capacity}}\n  vpc_zone_identifier = [{{vpc_zone_identifier}}]\n\n  launch_template {\n    id      = aws_launch_template.{{name}}.id\n    version = "$Latest"\n  }\n\n  health_check_type         = "ELB"\n  health_check_grace_period = 300\n\n  tag {\n    key                 = "Name"\n    value               = "{{name}}"\n    propagate_at_launch = true\n  }\n\n  tag {\n    key                 = "Environment"\n    value               = "{{environment}}"\n    propagate_at_launch = true\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/autoscaling/aws"\n  version = "~> 7.0"\n\n  name = "{{name}}"\n\n  image_id      = "{{ami_id}}"\n  instance_type = "{{instance_type}}"\n\n  min_size         = {{min_size}}\n  max_size         = {{max_size}}\n  desired_capacity = {{desired_capacity}}\n\n  vpc_zone_identifier = [{{vpc_zone_identifier}}]\n\n  tags = {\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'alb', 'Application Load Balancer', 'Compute', 'LOADBALANCER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_alb","required":true},{"id":"alb_name","label":"ALB Name","type":"text","default":"my-app-alb","required":true},{"id":"internal","label":"Internal (private)","type":"select","options":["false","true"],"default":"false"},{"id":"listener_port","label":"Listener Port","type":"number","default":"80"},{"id":"listener_protocol","label":"Listener Protocol","type":"select","options":["HTTP","HTTPS"],"default":"HTTP"},{"id":"target_port","label":"Target Port","type":"number","default":"80"},{"id":"target_protocol","label":"Target Protocol","type":"select","options":["HTTP","HTTPS"],"default":"HTTP"},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.public_a.id, aws_subnet.public_b.id"}]',
  'resource "aws_lb" "{{name}}" {\n  name               = "{{alb_name}}"\n  internal           = {{internal}}\n  load_balancer_type = "application"\n  subnets            = [{{subnet_ids}}]\n\n  enable_deletion_protection = false\n\n  tags = {\n    Name        = "{{alb_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}\n\nresource "aws_lb_target_group" "{{name}}" {\n  name     = "{{alb_name}}-tg"\n  port     = {{target_port}}\n  protocol = "{{target_protocol}}"\n  vpc_id   = {{vpc_id}}\n\n  health_check {\n    path                = "/"\n    healthy_threshold   = 2\n    unhealthy_threshold = 2\n  }\n\n  tags = { ManagedBy = "Terraform" }\n}\n\nresource "aws_lb_listener" "{{name}}" {\n  load_balancer_arn = aws_lb.{{name}}.arn\n  port              = {{listener_port}}\n  protocol          = "{{listener_protocol}}"\n\n  default_action {\n    type             = "forward"\n    target_group_arn = aws_lb_target_group.{{name}}.arn\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/alb/aws"\n  version = "~> 9.0"\n\n  name    = "{{alb_name}}"\n  vpc_id  = {{vpc_id}}\n  subnets = [{{subnet_ids}}]\n\n  internal = {{internal}}\n\n  tags = {\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'lambda', 'Lambda Function', 'Compute', 'FUNCTION',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_lambda","required":true},{"id":"function_name","label":"Function Name","type":"text","default":"my-function","required":true},{"id":"runtime","label":"Runtime","type":"select","options":["python3.12","python3.11","python3.10","nodejs20.x","nodejs18.x","java21","java17","go1.x","dotnet8"],"default":"python3.11"},{"id":"handler","label":"Handler","type":"text","default":"index.handler"},{"id":"timeout","label":"Timeout (seconds)","type":"number","default":"30"},{"id":"memory_size","label":"Memory Size (MB)","type":"select","options":["128","256","512","1024","2048","3008"],"default":"256"},{"id":"s3_bucket","label":"S3 Bucket (code source)","type":"text","default":"my-lambda-code-bucket"},{"id":"s3_key","label":"S3 Key (zip file)","type":"text","default":"function.zip"}]',
  'resource "aws_iam_role" "{{name}}" {\n  name = "{{function_name}}-role"\n\n  assume_role_policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Action    = "sts:AssumeRole"\n      Effect    = "Allow"\n      Principal = { Service = "lambda.amazonaws.com" }\n    }]\n  })\n}\n\nresource "aws_iam_role_policy_attachment" "{{name}}_basic" {\n  role       = aws_iam_role.{{name}}.name\n  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"\n}\n\nresource "aws_lambda_function" "{{name}}" {\n  function_name = "{{function_name}}"\n  runtime       = "{{runtime}}"\n  handler       = "{{handler}}"\n  timeout       = {{timeout}}\n  memory_size   = {{memory_size}}\n  role          = aws_iam_role.{{name}}.arn\n\n  s3_bucket = "{{s3_bucket}}"\n  s3_key    = "{{s3_key}}"\n\n  tags = {\n    Name        = "{{function_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/lambda/aws"\n  version = "~> 7.0"\n\n  function_name = "{{function_name}}"\n  runtime       = "{{runtime}}"\n  handler       = "{{handler}}"\n  timeout       = {{timeout}}\n  memory_size   = {{memory_size}}\n\n  create_package      = false\n  s3_existing_package = {\n    bucket = "{{s3_bucket}}"\n    key    = "{{s3_key}}"\n  }\n\n  tags = {\n    Name        = "{{function_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  's3', 'S3 Bucket', 'Storage', 'BUCKET',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_s3_bucket","required":true},{"id":"bucket_name","label":"Bucket Name","type":"text","default":"my-unique-bucket-name","required":true},{"id":"versioning","label":"Versioning","type":"select","options":["Enabled","Suspended"],"default":"Enabled"},{"id":"force_destroy","label":"Force Destroy","type":"select","options":["true","false"],"default":"false"},{"id":"block_public_acls","label":"Block Public ACLs","type":"select","options":["true","false"],"default":"true"},{"id":"lifecycle_days","label":"Transition to Glacier (days)","type":"number","default":"90"}]',
  'resource "aws_s3_bucket" "{{name}}" {\n  bucket        = "{{bucket_name}}"\n  force_destroy = {{force_destroy}}\n\n  tags = {\n    Name        = "{{bucket_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}\n\nresource "aws_s3_bucket_versioning" "{{name}}" {\n  bucket = aws_s3_bucket.{{name}}.id\n  versioning_configuration { status = "{{versioning}}" }\n}\n\nresource "aws_s3_bucket_server_side_encryption_configuration" "{{name}}" {\n  bucket = aws_s3_bucket.{{name}}.id\n  rule {\n    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }\n  }\n}\n\nresource "aws_s3_bucket_public_access_block" "{{name}}" {\n  bucket                  = aws_s3_bucket.{{name}}.id\n  block_public_acls       = {{block_public_acls}}\n  block_public_policy     = {{block_public_acls}}\n  ignore_public_acls      = {{block_public_acls}}\n  restrict_public_buckets = {{block_public_acls}}\n}\n\nresource "aws_s3_bucket_lifecycle_configuration" "{{name}}" {\n  bucket = aws_s3_bucket.{{name}}.id\n  rule {\n    id     = "transition-to-glacier"\n    status = "Enabled"\n    transition {\n      days          = {{lifecycle_days}}\n      storage_class = "GLACIER"\n    }\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/s3-bucket/aws"\n  version = "~> 4.0"\n\n  bucket        = "{{bucket_name}}"\n  force_destroy = {{force_destroy}}\n\n  versioning = { enabled = true }\n\n  server_side_encryption_configuration = {\n    rule = {\n      apply_server_side_encryption_by_default = {\n        sse_algorithm = "AES256"\n      }\n    }\n  }\n\n  block_public_acls       = {{block_public_acls}}\n  block_public_policy     = {{block_public_acls}}\n  ignore_public_acls      = {{block_public_acls}}\n  restrict_public_buckets = {{block_public_acls}}\n\n  tags = {\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ebs_volume', 'EBS Volume', 'Storage', 'DISK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ebs","required":true},{"id":"availability_zone","label":"Availability Zone","type":"select","options":["ap-south-1a","ap-south-1b","ap-south-1c","us-east-1a","us-east-1b","eu-west-1a"],"default":"ap-south-1a"},{"id":"size","label":"Volume Size (GB)","type":"number","default":"50"},{"id":"volume_type","label":"Volume Type","type":"select","options":["gp3","gp2","io1","io2","sc1","st1"],"default":"gp3"},{"id":"iops","label":"IOPS (for io1/io2/gp3)","type":"number","default":"3000"},{"id":"encrypted","label":"Encrypted","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_ebs_volume" "{{name}}" {\n  availability_zone = "{{availability_zone}}"\n  size              = {{size}}\n  type              = "{{volume_type}}"\n  iops              = {{iops}}\n  encrypted         = {{encrypted}}\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'efs', 'EFS File System', 'Storage', 'FILESHARE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_efs","required":true},{"id":"performance_mode","label":"Performance Mode","type":"select","options":["generalPurpose","maxIO"],"default":"generalPurpose"},{"id":"throughput_mode","label":"Throughput Mode","type":"select","options":["bursting","provisioned","elastic"],"default":"bursting"},{"id":"encrypted","label":"Encrypted","type":"select","options":["true","false"],"default":"true"},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id"},{"id":"subnet_id","label":"Subnet ID / Reference","type":"text","default":"aws_subnet.private_a.id"}]',
  'resource "aws_efs_file_system" "{{name}}" {\n  performance_mode = "{{performance_mode}}"\n  throughput_mode  = "{{throughput_mode}}"\n  encrypted        = {{encrypted}}\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}\n\nresource "aws_security_group" "{{name}}_efs" {\n  name   = "{{name}}-efs-sg"\n  vpc_id = {{vpc_id}}\n\n  ingress {\n    from_port   = 2049\n    to_port     = 2049\n    protocol    = "tcp"\n    cidr_blocks = ["10.0.0.0/8"]\n  }\n\n  egress {\n    from_port   = 0\n    to_port     = 0\n    protocol    = "-1"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n\nresource "aws_efs_mount_target" "{{name}}" {\n  file_system_id  = aws_efs_file_system.{{name}}.id\n  subnet_id       = {{subnet_id}}\n  security_groups = [aws_security_group.{{name}}_efs.id]\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/efs/aws"\n  version = "~> 1.0"\n\n  name = "{{name}}"\n\n  performance_mode = "{{performance_mode}}"\n  throughput_mode  = "{{throughput_mode}}"\n  encrypted        = {{encrypted}}\n\n  mount_targets = {\n    "ap-south-1a" = { subnet_id = {{subnet_id}} }\n  }\n\n  tags = {\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- NETWORKING
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc', 'VPC', 'Networking', 'NETWORK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_vpc","required":true},{"id":"cidr_block","label":"CIDR Block","type":"text","default":"10.0.0.0/16","required":true},{"id":"enable_dns_hostnames","label":"DNS Hostnames","type":"select","options":["true","false"],"default":"true"},{"id":"enable_dns_support","label":"DNS Support","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_vpc" "{{name}}" {\n  cidr_block           = "{{cidr_block}}"\n  enable_dns_hostnames = {{enable_dns_hostnames}}\n  enable_dns_support   = {{enable_dns_support}}\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "~> 5.0"\n\n  name = "{{name}}"\n  cidr = "{{cidr_block}}"\n\n  azs             = ["ap-south-1a", "ap-south-1b"]\n  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]\n  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]\n\n  enable_nat_gateway   = true\n  single_nat_gateway   = false\n  enable_dns_hostnames = {{enable_dns_hostnames}}\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'subnet', 'Subnet', 'Networking', 'SUBNET',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_subnet","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"cidr_block","label":"CIDR Block","type":"text","default":"10.0.1.0/24","required":true},{"id":"availability_zone","label":"Availability Zone","type":"select","options":["ap-south-1a","ap-south-1b","ap-south-1c","us-east-1a","us-east-1b","eu-west-1a","eu-west-1b"],"default":"ap-south-1a"},{"id":"map_public_ip","label":"Map Public IP on Launch","type":"select","options":["true","false"],"default":"false"}]',
  'resource "aws_subnet" "{{name}}" {\n  vpc_id                  = {{vpc_id}}\n  cidr_block              = "{{cidr_block}}"\n  availability_zone       = "{{availability_zone}}"\n  map_public_ip_on_launch = {{map_public_ip}}\n\n  tags = {\n    Name        = "{{name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'security_group', 'Security Group', 'Networking', 'SHIELD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sg","required":true},{"id":"sg_name","label":"SG Display Name","type":"text","default":"my-security-group","required":true},{"id":"description","label":"Description","type":"text","default":"Managed by Terraform"},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"ingress_port","label":"Ingress Port (e.g. 80)","type":"text","default":"80"},{"id":"ingress_protocol","label":"Ingress Protocol","type":"select","options":["tcp","udp","-1"],"default":"tcp"},{"id":"ingress_cidr","label":"Ingress CIDR","type":"text","default":"0.0.0.0/0"}]',
  'resource "aws_security_group" "{{name}}" {\n  name        = "{{sg_name}}"\n  description = "{{description}}"\n  vpc_id      = {{vpc_id}}\n\n  ingress {\n    from_port   = {{ingress_port}}\n    to_port     = {{ingress_port}}\n    protocol    = "{{ingress_protocol}}"\n    cidr_blocks = ["{{ingress_cidr}}"]\n  }\n\n  egress {\n    from_port   = 0\n    to_port     = 0\n    protocol    = "-1"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n\n  tags = {\n    Name      = "{{sg_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'internet_gateway', 'Internet Gateway', 'Networking', 'GLOBE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_igw","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true}]',
  'resource "aws_internet_gateway" "{{name}}" {\n  vpc_id = {{vpc_id}}\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'nat_gateway', 'NAT Gateway', 'Networking', 'GATEWAY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_nat","required":true},{"id":"subnet_id","label":"Subnet ID / Reference (Public Subnet)","type":"text","default":"aws_subnet.public_a.id","required":true},{"id":"allocation_id","label":"EIP Allocation ID / Reference","type":"text","default":"aws_eip.nat.id","required":true}]',
  'resource "aws_eip" "{{name}}" {\n  domain = "vpc"\n  tags = { Name = "{{name}}-eip" }\n}\n\nresource "aws_nat_gateway" "{{name}}" {\n  allocation_id = {{allocation_id}}\n  subnet_id     = {{subnet_id}}\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n\n  depends_on = [aws_internet_gateway.igw]\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'route_table', 'Route Table', 'Networking', 'ROUTE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_rt","required":true},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"gateway_id","label":"Gateway ID / Reference (IGW or NAT)","type":"text","default":"aws_internet_gateway.my_igw.id"},{"id":"destination_cidr","label":"Destination CIDR","type":"text","default":"0.0.0.0/0"},{"id":"subnet_id","label":"Subnet ID / Reference to Associate","type":"text","default":"aws_subnet.my_subnet.id"}]',
  'resource "aws_route_table" "{{name}}" {\n  vpc_id = {{vpc_id}}\n\n  route {\n    cidr_block = "{{destination_cidr}}"\n    gateway_id = {{gateway_id}}\n  }\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_route_table_association" "{{name}}" {\n  subnet_id      = {{subnet_id}}\n  route_table_id = aws_route_table.{{name}}.id\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'route53_zone', 'Route 53 Hosted Zone', 'Networking', 'DNS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_zone","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"example.com","required":true},{"id":"private_zone","label":"Private Zone","type":"select","options":["false","true"],"default":"false"},{"id":"vpc_id","label":"VPC ID (if private zone)","type":"text","default":""}]',
  'resource "aws_route53_zone" "{{name}}" {\n  name = "{{domain_name}}"\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_route53_record" "{{name}}_www" {\n  zone_id = aws_route53_zone.{{name}}.zone_id\n  name    = "www.{{domain_name}}"\n  type    = "A"\n\n  alias {\n    name                   = "your-alb-dns-name"\n    zone_id                = "your-alb-zone-id"\n    evaluate_target_health = true\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudfront', 'CloudFront Distribution', 'Networking', 'CDN',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cf","required":true},{"id":"origin_domain","label":"Origin Domain Name","type":"text","default":"my-bucket.s3.amazonaws.com","required":true},{"id":"origin_id","label":"Origin ID","type":"text","default":"S3Origin"},{"id":"default_root_object","label":"Default Root Object","type":"text","default":"index.html"},{"id":"price_class","label":"Price Class","type":"select","options":["PriceClass_100","PriceClass_200","PriceClass_All"],"default":"PriceClass_100"},{"id":"min_ttl","label":"Min TTL (seconds)","type":"number","default":"0"},{"id":"default_ttl","label":"Default TTL (seconds)","type":"number","default":"86400"}]',
  'resource "aws_cloudfront_distribution" "{{name}}" {\n  origin {\n    domain_name = "{{origin_domain}}"\n    origin_id   = "{{origin_id}}"\n  }\n\n  enabled             = true\n  default_root_object = "{{default_root_object}}"\n  price_class         = "{{price_class}}"\n\n  default_cache_behavior {\n    allowed_methods        = ["GET", "HEAD"]\n    cached_methods         = ["GET", "HEAD"]\n    target_origin_id       = "{{origin_id}}"\n    viewer_protocol_policy = "redirect-to-https"\n\n    forwarded_values {\n      query_string = false\n      cookies { forward = "none" }\n    }\n\n    min_ttl     = {{min_ttl}}\n    default_ttl = {{default_ttl}}\n    max_ttl     = 31536000\n  }\n\n  restrictions {\n    geo_restriction { restriction_type = "none" }\n  }\n\n  viewer_certificate {\n    cloudfront_default_certificate = true\n  }\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- DATABASE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'rds', 'RDS Database', 'Database', 'DATABASE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_rds","required":true},{"id":"identifier","label":"DB Identifier","type":"text","default":"mydb","required":true},{"id":"engine","label":"Engine","type":"select","options":["mysql","postgres","mariadb"],"default":"postgres"},{"id":"engine_version","label":"Engine Version","type":"text","default":"15.3"},{"id":"instance_class","label":"Instance Class","type":"select","options":["db.t3.micro","db.t3.small","db.t3.medium","db.t4g.micro","db.t4g.small","db.m5.large","db.m6g.large"],"default":"db.t3.micro"},{"id":"allocated_storage","label":"Allocated Storage (GB)","type":"number","default":"20"},{"id":"db_name","label":"Database Name","type":"text","default":"appdb"},{"id":"username","label":"Master Username","type":"text","default":"admin"},{"id":"multi_az","label":"Multi-AZ","type":"select","options":["false","true"],"default":"false"},{"id":"backup_retention","label":"Backup Retention (days)","type":"number","default":"7"},{"id":"skip_final_snapshot","label":"Skip Final Snapshot","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_db_instance" "{{name}}" {\n  identifier        = "{{identifier}}"\n  engine            = "{{engine}}"\n  engine_version    = "{{engine_version}}"\n  instance_class    = "{{instance_class}}"\n  allocated_storage = {{allocated_storage}}\n\n  db_name  = "{{db_name}}"\n  username = "{{username}}"\n  password = var.db_password\n\n  multi_az                = {{multi_az}}\n  backup_retention_period = {{backup_retention}}\n  skip_final_snapshot     = {{skip_final_snapshot}}\n  deletion_protection     = false\n  storage_encrypted       = true\n\n  tags = {\n    Name      = "{{identifier}}"\n    ManagedBy = "Terraform"\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/rds/aws"\n  version = "~> 6.0"\n\n  identifier     = "{{identifier}}"\n  engine         = "{{engine}}"\n  engine_version = "{{engine_version}}"\n  instance_class = "{{instance_class}}"\n\n  allocated_storage = {{allocated_storage}}\n\n  db_name  = "{{db_name}}"\n  username = "{{username}}"\n  port     = "5432"\n\n  multi_az                = {{multi_az}}\n  backup_retention_period = {{backup_retention}}\n\n  tags = {\n    Name      = "{{identifier}}"\n    ManagedBy = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'dynamodb', 'DynamoDB Table', 'Database', 'DYNAMODB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_dynamo","required":true},{"id":"table_name","label":"Table Name","type":"text","default":"my-table","required":true},{"id":"billing_mode","label":"Billing Mode","type":"select","options":["PAY_PER_REQUEST","PROVISIONED"],"default":"PAY_PER_REQUEST"},{"id":"hash_key","label":"Hash (Partition) Key","type":"text","default":"id"},{"id":"hash_key_type","label":"Hash Key Type","type":"select","options":["S","N","B"],"default":"S"},{"id":"range_key","label":"Range (Sort) Key (optional)","type":"text","default":""},{"id":"read_capacity","label":"Read Capacity Units (PROVISIONED only)","type":"number","default":"5"},{"id":"write_capacity","label":"Write Capacity Units (PROVISIONED only)","type":"number","default":"5"},{"id":"pitr_enabled","label":"Point-in-Time Recovery","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_dynamodb_table" "{{name}}" {\n  name         = "{{table_name}}"\n  billing_mode = "{{billing_mode}}"\n  hash_key     = "{{hash_key}}"\n\n  attribute {\n    name = "{{hash_key}}"\n    type = "{{hash_key_type}}"\n  }\n\n  point_in_time_recovery {\n    enabled = {{pitr_enabled}}\n  }\n\n  server_side_encryption {\n    enabled = true\n  }\n\n  tags = {\n    Name        = "{{table_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/dynamodb-table/aws"\n  version = "~> 4.0"\n\n  name         = "{{table_name}}"\n  billing_mode = "{{billing_mode}}"\n  hash_key     = "{{hash_key}}"\n\n  attributes = [\n    { name = "{{hash_key}}", type = "{{hash_key_type}}" }\n  ]\n\n  point_in_time_recovery_enabled = {{pitr_enabled}}\n\n  tags = {\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'elasticache', 'ElastiCache Cluster', 'Database', 'CACHE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cache","required":true},{"id":"cluster_id","label":"Cluster ID","type":"text","default":"my-cache","required":true},{"id":"engine","label":"Engine","type":"select","options":["redis","memcached"],"default":"redis"},{"id":"engine_version","label":"Engine Version","type":"text","default":"7.0"},{"id":"node_type","label":"Node Type","type":"select","options":["cache.t3.micro","cache.t3.small","cache.t3.medium","cache.m6g.large"],"default":"cache.t3.micro"},{"id":"num_cache_nodes","label":"Number of Nodes","type":"number","default":"1"},{"id":"port","label":"Port","type":"number","default":"6379"}]',
  'resource "aws_elasticache_cluster" "{{name}}" {\n  cluster_id           = "{{cluster_id}}"\n  engine               = "{{engine}}"\n  engine_version       = "{{engine_version}}"\n  node_type            = "{{node_type}}"\n  num_cache_nodes      = {{num_cache_nodes}}\n  port                 = {{port}}\n  parameter_group_name = "default.redis7"\n\n  tags = {\n    Name      = "{{cluster_id}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- IAM (Security)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_role', 'IAM Role', 'IAM & Security', 'LOCK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_iam_role","required":true},{"id":"role_name","label":"Role Name","type":"text","default":"my-app-role","required":true},{"id":"trusted_service","label":"Trusted Service","type":"select","options":["ec2.amazonaws.com","lambda.amazonaws.com","ecs-tasks.amazonaws.com","eks.amazonaws.com","codebuild.amazonaws.com","codedeploy.amazonaws.com","ssm.amazonaws.com"],"default":"ec2.amazonaws.com"},{"id":"managed_policy_arn","label":"Managed Policy ARN","type":"text","default":"arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"}]',
  'resource "aws_iam_role" "{{name}}" {\n  name = "{{role_name}}"\n\n  assume_role_policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Action    = "sts:AssumeRole"\n      Effect    = "Allow"\n      Principal = {\n        Service = "{{trusted_service}}"\n      }\n    }]\n  })\n\n  tags = {\n    Name      = "{{role_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_iam_role_policy_attachment" "{{name}}" {\n  role       = aws_iam_role.{{name}}.name\n  policy_arn = "{{managed_policy_arn}}"\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_user', 'IAM User', 'IAM & Security', 'USER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_iam_user","required":true},{"id":"username","label":"IAM Username","type":"text","default":"devops-user","required":true},{"id":"path","label":"Path","type":"text","default":"/"},{"id":"group_name","label":"IAM Group Name (optional)","type":"text","default":""},{"id":"console_access","label":"Enable Console Access","type":"select","options":["true","false"],"default":"false"},{"id":"policy_arn","label":"Managed Policy ARN","type":"text","default":"arn:aws:iam::aws:policy/ReadOnlyAccess"}]',
  'resource "aws_iam_user" "{{name}}" {\n  name = "{{username}}"\n  path = "{{path}}"\n\n  tags = {\n    Name      = "{{username}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_iam_user_policy_attachment" "{{name}}" {\n  user       = aws_iam_user.{{name}}.name\n  policy_arn = "{{policy_arn}}"\n}\n\nresource "aws_iam_access_key" "{{name}}" {\n  user = aws_iam_user.{{name}}.name\n}\n\noutput "{{name}}_access_key_id" {\n  value     = aws_iam_access_key.{{name}}.id\n  sensitive = true\n}\n\noutput "{{name}}_secret_access_key" {\n  value     = aws_iam_access_key.{{name}}.secret\n  sensitive = true\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_policy', 'IAM Policy', 'IAM & Security', 'POLICY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_policy","required":true},{"id":"policy_name","label":"Policy Name","type":"text","default":"my-custom-policy","required":true},{"id":"description","label":"Description","type":"text","default":"Custom IAM policy"},{"id":"effect","label":"Effect","type":"select","options":["Allow","Deny"],"default":"Allow"},{"id":"actions","label":"Actions (comma-sep, e.g. s3:GetObject,s3:PutObject)","type":"text","default":"s3:GetObject,s3:ListBucket"},{"id":"resources","label":"Resources ARN","type":"text","default":"arn:aws:s3:::my-bucket/*"}]',
  'resource "aws_iam_policy" "{{name}}" {\n  name        = "{{policy_name}}"\n  description = "{{description}}"\n\n  policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Effect   = "{{effect}}"\n      Action   = split(",", "{{actions}}")\n      Resource = "{{resources}}"\n    }]\n  })\n\n  tags = {\n    Name      = "{{policy_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_group', 'IAM Group', 'IAM & Security', 'USERGROUP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_group","required":true},{"id":"group_name","label":"Group Name","type":"text","default":"developers","required":true},{"id":"path","label":"Path","type":"text","default":"/"},{"id":"policy_arn","label":"Managed Policy ARN","type":"text","default":"arn:aws:iam::aws:policy/PowerUserAccess"}]',
  'resource "aws_iam_group" "{{name}}" {\n  name = "{{group_name}}"\n  path = "{{path}}"\n}\n\nresource "aws_iam_group_policy_attachment" "{{name}}" {\n  group      = aws_iam_group.{{name}}.name\n  policy_arn = "{{policy_arn}}"\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'kms_key', 'KMS Key', 'IAM & Security', 'KEY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_kms","required":true},{"id":"description","label":"Key Description","type":"text","default":"KMS key for encryption"},{"id":"deletion_window","label":"Deletion Window (days)","type":"number","default":"30"},{"id":"enable_rotation","label":"Enable Key Rotation","type":"select","options":["true","false"],"default":"true"},{"id":"multi_region","label":"Multi-Region Key","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_kms_key" "{{name}}" {\n  description             = "{{description}}"\n  deletion_window_in_days = {{deletion_window}}\n  enable_key_rotation     = {{enable_rotation}}\n  multi_region            = {{multi_region}}\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_kms_alias" "{{name}}" {\n  name          = "alias/{{name}}"\n  target_key_id = aws_kms_key.{{name}}.key_id\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'secrets_manager', 'Secrets Manager', 'IAM & Security', 'SECRET',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_secret","required":true},{"id":"secret_name","label":"Secret Name","type":"text","default":"/app/prod/db-password","required":true},{"id":"description","label":"Description","type":"text","default":"Application secret"},{"id":"recovery_window","label":"Recovery Window (days, 0 = force delete)","type":"number","default":"30"},{"id":"kms_key_id","label":"KMS Key ID / Reference (optional)","type":"text","default":""}]',
  'resource "aws_secretsmanager_secret" "{{name}}" {\n  name                    = "{{secret_name}}"\n  description             = "{{description}}"\n  recovery_window_in_days = {{recovery_window}}\n\n  tags = {\n    Name      = "{{secret_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_secretsmanager_secret_version" "{{name}}" {\n  secret_id     = aws_secretsmanager_secret.{{name}}.id\n  secret_string = jsonencode({\n    username = "admin"\n    password = "change-me-via-console-or-rotation"\n  })\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- MONITORING
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_alarm', 'CloudWatch Alarm', 'Monitoring', 'ALARM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_alarm","required":true},{"id":"alarm_name","label":"Alarm Name","type":"text","default":"high-cpu-alarm","required":true},{"id":"metric_name","label":"Metric Name","type":"select","options":["CPUUtilization","NetworkIn","NetworkOut","DiskReadOps","DiskWriteOps","StatusCheckFailed"],"default":"CPUUtilization"},{"id":"namespace","label":"Namespace","type":"text","default":"AWS/EC2"},{"id":"threshold","label":"Threshold","type":"number","default":"80"},{"id":"comparison","label":"Comparison","type":"select","options":["GreaterThanThreshold","LessThanThreshold","GreaterThanOrEqualToThreshold","LessThanOrEqualToThreshold"],"default":"GreaterThanThreshold"},{"id":"evaluation_periods","label":"Evaluation Periods","type":"number","default":"2"},{"id":"period","label":"Period (seconds)","type":"number","default":"300"},{"id":"sns_arn","label":"SNS Topic ARN (for notifications)","type":"text","default":""}]',
  'resource "aws_cloudwatch_metric_alarm" "{{name}}" {\n  alarm_name          = "{{alarm_name}}"\n  comparison_operator = "{{comparison}}"\n  evaluation_periods  = {{evaluation_periods}}\n  metric_name         = "{{metric_name}}"\n  namespace           = "{{namespace}}"\n  period              = {{period}}\n  statistic           = "Average"\n  threshold           = {{threshold}}\n\n  alarm_description = "Alarm for {{metric_name}} exceeding {{threshold}}"\n  alarm_actions     = ["{{sns_arn}}"]\n  ok_actions        = ["{{sns_arn}}"]\n\n  tags = {\n    Name      = "{{alarm_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_log_group', 'CloudWatch Log Group', 'Monitoring', 'LOGS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_log_group","required":true},{"id":"log_group_name","label":"Log Group Name","type":"text","default":"/app/my-service","required":true},{"id":"retention_days","label":"Retention (days)","type":"select","options":["1","3","5","7","14","30","60","90","120","180","365","400","545","731","1827","3653"],"default":"30"},{"id":"kms_key_id","label":"KMS Key ARN (optional)","type":"text","default":""}]',
  'resource "aws_cloudwatch_log_group" "{{name}}" {\n  name              = "{{log_group_name}}"\n  retention_in_days = {{retention_days}}\n\n  tags = {\n    Name        = "{{log_group_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sns_topic', 'SNS Topic', 'Monitoring', 'SNS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sns","required":true},{"id":"topic_name","label":"Topic Name","type":"text","default":"my-notifications","required":true},{"id":"display_name","label":"Display Name","type":"text","default":"App Notifications"},{"id":"email_subscription","label":"Email Subscription Address","type":"text","default":"team@example.com"},{"id":"fifo","label":"FIFO Topic","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_sns_topic" "{{name}}" {\n  name         = "{{topic_name}}"\n  display_name = "{{display_name}}"\n\n  tags = {\n    Name      = "{{topic_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_sns_topic_subscription" "{{name}}_email" {\n  topic_arn = aws_sns_topic.{{name}}.arn\n  protocol  = "email"\n  endpoint  = "{{email_subscription}}"\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sqs_queue', 'SQS Queue', 'Monitoring', 'QUEUE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sqs","required":true},{"id":"queue_name","label":"Queue Name","type":"text","default":"my-queue","required":true},{"id":"visibility_timeout","label":"Visibility Timeout (seconds)","type":"number","default":"30"},{"id":"message_retention","label":"Message Retention (seconds)","type":"number","default":"86400"},{"id":"max_message_size","label":"Max Message Size (bytes)","type":"number","default":"262144"},{"id":"delay_seconds","label":"Delay Seconds","type":"number","default":"0"},{"id":"fifo","label":"FIFO Queue","type":"select","options":["false","true"],"default":"false"},{"id":"encryption","label":"Enable SSE Encryption","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_sqs_queue" "{{name}}" {\n  name                       = "{{queue_name}}"\n  visibility_timeout_seconds = {{visibility_timeout}}\n  message_retention_seconds  = {{message_retention}}\n  max_message_size           = {{max_message_size}}\n  delay_seconds              = {{delay_seconds}}\n  sqs_managed_sse_enabled    = {{encryption}}\n\n  tags = {\n    Name        = "{{queue_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}\n\nresource "aws_sqs_queue" "{{name}}_dlq" {\n  name = "{{queue_name}}-dlq"\n\n  tags = { Name = "{{queue_name}}-dlq", ManagedBy = "Terraform" }\n}\n\nresource "aws_sqs_queue_redrive_policy" "{{name}}" {\n  queue_url = aws_sqs_queue.{{name}}.id\n  redrive_policy = jsonencode({\n    deadLetterTargetArn = aws_sqs_queue.{{name}}_dlq.arn\n    maxReceiveCount     = 3\n  })\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eventbridge_rule', 'EventBridge Rule', 'Monitoring', 'EVENT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_event_rule","required":true},{"id":"rule_name","label":"Rule Name","type":"text","default":"my-schedule","required":true},{"id":"description","label":"Description","type":"text","default":"Scheduled EventBridge rule"},{"id":"schedule_expression","label":"Schedule Expression","type":"text","default":"rate(5 minutes)"},{"id":"lambda_arn","label":"Target Lambda ARN","type":"text","default":"aws_lambda_function.my_lambda.arn"},{"id":"enabled","label":"Enabled","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_cloudwatch_event_rule" "{{name}}" {\n  name                = "{{rule_name}}"\n  description         = "{{description}}"\n  schedule_expression = "{{schedule_expression}}"\n  is_enabled          = {{enabled}}\n\n  tags = {\n    Name      = "{{rule_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_cloudwatch_event_target" "{{name}}" {\n  rule      = aws_cloudwatch_event_rule.{{name}}.name\n  target_id = "{{rule_name}}-target"\n  arn       = {{lambda_arn}}\n}\n\nresource "aws_lambda_permission" "{{name}}" {\n  statement_id  = "AllowEventBridge"\n  action        = "lambda:InvokeFunction"\n  function_name = {{lambda_arn}}\n  principal     = "events.amazonaws.com"\n  source_arn    = aws_cloudwatch_event_rule.{{name}}.arn\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTAINERS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eks', 'EKS Cluster', 'Containers', 'CLUSTER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_eks","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-eks-cluster","required":true},{"id":"k8s_version","label":"Kubernetes Version","type":"select","options":["1.30","1.29","1.28","1.27"],"default":"1.30"},{"id":"node_instance_type","label":"Node Instance Type","type":"select","options":["t3.medium","t3.large","t3.xlarge","m5.large","m5.xlarge","m6i.large"],"default":"t3.medium"},{"id":"min_size","label":"Min Nodes","type":"number","default":"2"},{"id":"max_size","label":"Max Nodes","type":"number","default":"5"},{"id":"desired_size","label":"Desired Nodes","type":"number","default":"2"},{"id":"endpoint_public_access","label":"Public API Endpoint","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_eks_cluster" "{{name}}" {\n  name     = "{{cluster_name}}"\n  version  = "{{k8s_version}}"\n  role_arn = aws_iam_role.eks_cluster.arn\n\n  vpc_config {\n    subnet_ids              = var.subnet_ids\n    endpoint_public_access  = {{endpoint_public_access}}\n    endpoint_private_access = true\n  }\n\n  tags = {\n    Name      = "{{cluster_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_eks_node_group" "{{name}}" {\n  cluster_name    = aws_eks_cluster.{{name}}.name\n  node_group_name = "{{cluster_name}}-nodes"\n  node_role_arn   = aws_iam_role.eks_node.arn\n  subnet_ids      = var.subnet_ids\n  instance_types  = ["{{node_instance_type}}"]\n\n  scaling_config {\n    min_size     = {{min_size}}\n    max_size     = {{max_size}}\n    desired_size = {{desired_size}}\n  }\n\n  tags = { Name = "{{cluster_name}}-nodes", ManagedBy = "Terraform" }\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/eks/aws"\n  version = "~> 20.0"\n\n  cluster_name    = "{{cluster_name}}"\n  cluster_version = "{{k8s_version}}"\n\n  cluster_endpoint_public_access = {{endpoint_public_access}}\n\n  vpc_id     = var.vpc_id\n  subnet_ids = var.subnet_ids\n\n  eks_managed_node_groups = {\n    default = {\n      instance_types = ["{{node_instance_type}}"]\n      min_size       = {{min_size}}\n      max_size       = {{max_size}}\n      desired_size   = {{desired_size}}\n    }\n  }\n\n  tags = {\n    Name      = "{{cluster_name}}"\n    ManagedBy = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecs_cluster', 'ECS Cluster', 'Containers', 'CONTAINERS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ecs","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-ecs-cluster","required":true},{"id":"launch_type","label":"Launch Type","type":"select","options":["FARGATE","EC2"],"default":"FARGATE"},{"id":"cpu","label":"Task CPU (vCPU units)","type":"select","options":["256","512","1024","2048","4096"],"default":"256"},{"id":"memory","label":"Task Memory (MB)","type":"select","options":["512","1024","2048","4096","8192"],"default":"512"},{"id":"container_image","label":"Container Image URI","type":"text","default":"nginx:latest"},{"id":"container_port","label":"Container Port","type":"number","default":"80"}]',
  'resource "aws_ecs_cluster" "{{name}}" {\n  name = "{{cluster_name}}"\n\n  setting {\n    name  = "containerInsights"\n    value = "enabled"\n  }\n\n  tags = {\n    Name      = "{{cluster_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_iam_role" "{{name}}_task" {\n  name = "{{cluster_name}}-task-role"\n  assume_role_policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]\n  })\n}\n\nresource "aws_ecs_task_definition" "{{name}}" {\n  family                   = "{{cluster_name}}-task"\n  network_mode             = "awsvpc"\n  requires_compatibilities = ["{{launch_type}}"]\n  cpu                      = "{{cpu}}"\n  memory                   = "{{memory}}"\n  execution_role_arn       = aws_iam_role.{{name}}_task.arn\n\n  container_definitions = jsonencode([{\n    name      = "app"\n    image     = "{{container_image}}"\n    essential = true\n    portMappings = [{ containerPort = {{container_port}}, hostPort = {{container_port}} }]\n  }])\n}',
  'module "{{name}}" {\n  source  = "terraform-aws-modules/ecs/aws"\n  version = "~> 5.0"\n\n  cluster_name = "{{cluster_name}}"\n\n  fargate_capacity_providers = {\n    FARGATE      = { default_capacity_provider_strategy = { weight = 50 } }\n    FARGATE_SPOT = { default_capacity_provider_strategy = { weight = 50 } }\n  }\n\n  tags = {\n    Name      = "{{cluster_name}}"\n    ManagedBy = "Terraform"\n  }\n}'
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecr_repository', 'ECR Repository', 'Containers', 'REGISTRY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ecr","required":true},{"id":"repo_name","label":"Repository Name","type":"text","default":"my-app","required":true},{"id":"mutability","label":"Image Tag Mutability","type":"select","options":["MUTABLE","IMMUTABLE"],"default":"MUTABLE"},{"id":"scan_on_push","label":"Scan on Push (vulnerability check)","type":"select","options":["true","false"],"default":"true"},{"id":"encryption_type","label":"Encryption Type","type":"select","options":["AES256","KMS"],"default":"AES256"},{"id":"lifecycle_count","label":"Keep Last N Images","type":"number","default":"10"}]',
  'resource "aws_ecr_repository" "{{name}}" {\n  name                 = "{{repo_name}}"\n  image_tag_mutability = "{{mutability}}"\n\n  image_scanning_configuration {\n    scan_on_push = {{scan_on_push}}\n  }\n\n  encryption_configuration {\n    encryption_type = "{{encryption_type}}"\n  }\n\n  tags = {\n    Name      = "{{repo_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_ecr_lifecycle_policy" "{{name}}" {\n  repository = aws_ecr_repository.{{name}}.name\n\n  policy = jsonencode({\n    rules = [{\n      rulePriority = 1\n      description  = "Keep last {{lifecycle_count}} images"\n      selection = {\n        tagStatus   = "any"\n        countType   = "imageCountMoreThan"\n        countNumber = {{lifecycle_count}}\n      }\n      action = { type = "expire" }\n    }]\n  })\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CI/CD
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codepipeline', 'CodePipeline', 'CI/CD', 'PIPELINE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_pipeline","required":true},{"id":"pipeline_name","label":"Pipeline Name","type":"text","default":"my-app-pipeline","required":true},{"id":"artifact_bucket","label":"Artifact S3 Bucket Name","type":"text","default":"my-codepipeline-artifacts","required":true},{"id":"github_repo","label":"GitHub Repo (owner/repo)","type":"text","default":"my-org/my-repo"},{"id":"github_branch","label":"GitHub Branch","type":"text","default":"main"},{"id":"build_project","label":"CodeBuild Project Name","type":"text","default":"my-build-project"}]',
  'resource "aws_codepipeline" "{{name}}" {\n  name     = "{{pipeline_name}}"\n  role_arn = aws_iam_role.{{name}}_pipeline.arn\n\n  artifact_store {\n    location = "{{artifact_bucket}}"\n    type     = "S3"\n  }\n\n  stage {\n    name = "Source"\n    action {\n      name             = "Source"\n      category         = "Source"\n      owner            = "ThirdParty"\n      provider         = "GitHub"\n      version          = "1"\n      output_artifacts = ["source_output"]\n      configuration = {\n        Owner  = split("/", "{{github_repo}}")[0]\n        Repo   = split("/", "{{github_repo}}")[1]\n        Branch = "{{github_branch}}"\n      }\n    }\n  }\n\n  stage {\n    name = "Build"\n    action {\n      name             = "Build"\n      category         = "Build"\n      owner            = "AWS"\n      provider         = "CodeBuild"\n      input_artifacts  = ["source_output"]\n      output_artifacts = ["build_output"]\n      version          = "1"\n      configuration = {\n        ProjectName = "{{build_project}}"\n      }\n    }\n  }\n\n  tags = {\n    Name      = "{{pipeline_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codebuild', 'CodeBuild Project', 'CI/CD', 'BUILD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_build","required":true},{"id":"project_name","label":"Project Name","type":"text","default":"my-build-project","required":true},{"id":"description","label":"Description","type":"text","default":"Build and test project"},{"id":"build_image","label":"Build Image","type":"select","options":["aws/codebuild/standard:7.0","aws/codebuild/standard:6.0","aws/codebuild/amazonlinux2-x86_64-standard:5.0"],"default":"aws/codebuild/standard:7.0"},{"id":"compute_type","label":"Compute Type","type":"select","options":["BUILD_GENERAL1_SMALL","BUILD_GENERAL1_MEDIUM","BUILD_GENERAL1_LARGE"],"default":"BUILD_GENERAL1_SMALL"},{"id":"artifact_bucket","label":"Output Artifact S3 Bucket","type":"text","default":"my-build-artifacts"},{"id":"timeout","label":"Build Timeout (minutes)","type":"number","default":"30"}]',
  'resource "aws_codebuild_project" "{{name}}" {\n  name          = "{{project_name}}"\n  description   = "{{description}}"\n  build_timeout = {{timeout}}\n  service_role  = aws_iam_role.{{name}}_codebuild.arn\n\n  source {\n    type = "CODEPIPELINE"\n    buildspec = "buildspec.yml"\n  }\n\n  environment {\n    compute_type                = "{{compute_type}}"\n    image                       = "{{build_image}}"\n    type                        = "LINUX_CONTAINER"\n    image_pull_credentials_type = "CODEBUILD"\n  }\n\n  artifacts {\n    type   = "S3"\n    location = "{{artifact_bucket}}"\n  }\n\n  tags = {\n    Name      = "{{project_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codedeploy', 'CodeDeploy Application', 'CI/CD', 'DEPLOY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_deploy","required":true},{"id":"app_name","label":"Application Name","type":"text","default":"my-app","required":true},{"id":"compute_platform","label":"Compute Platform","type":"select","options":["Server","ECS","Lambda"],"default":"Server"},{"id":"deployment_group","label":"Deployment Group Name","type":"text","default":"my-deployment-group"},{"id":"deployment_type","label":"Deployment Type","type":"select","options":["IN_PLACE","BLUE_GREEN"],"default":"IN_PLACE"},{"id":"asg_name","label":"Auto Scaling Group Name (if EC2)","type":"text","default":""}]',
  'resource "aws_codedeploy_app" "{{name}}" {\n  name             = "{{app_name}}"\n  compute_platform = "{{compute_platform}}"\n}\n\nresource "aws_codedeploy_deployment_group" "{{name}}" {\n  app_name               = aws_codedeploy_app.{{name}}.name\n  deployment_group_name  = "{{deployment_group}}"\n  service_role_arn       = aws_iam_role.{{name}}_codedeploy.arn\n\n  deployment_config_name = "CodeDeployDefault.OneAtATime"\n\n  deployment_style {\n    deployment_option = "WITHOUT_TRAFFIC_CONTROL"\n    deployment_type   = "{{deployment_type}}"\n  }\n\n  auto_rollback_configuration {\n    enabled = true\n    events  = ["DEPLOYMENT_FAILURE"]\n  }\n\n  tags = {\n    Name      = "{{deployment_group}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'api_gateway', 'API Gateway (REST)', 'CI/CD', 'APIGATEWAY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_api","required":true},{"id":"api_name","label":"API Name","type":"text","default":"my-rest-api","required":true},{"id":"description","label":"Description","type":"text","default":"REST API"},{"id":"stage_name","label":"Stage Name","type":"text","default":"prod"},{"id":"lambda_arn","label":"Backend Lambda ARN","type":"text","default":"aws_lambda_function.my_fn.arn"},{"id":"endpoint_type","label":"Endpoint Type","type":"select","options":["REGIONAL","EDGE","PRIVATE"],"default":"REGIONAL"}]',
  'resource "aws_api_gateway_rest_api" "{{name}}" {\n  name        = "{{api_name}}"\n  description = "{{description}}"\n\n  endpoint_configuration {\n    types = ["{{endpoint_type}}"]\n  }\n\n  tags = {\n    Name      = "{{api_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_api_gateway_resource" "{{name}}" {\n  rest_api_id = aws_api_gateway_rest_api.{{name}}.id\n  parent_id   = aws_api_gateway_rest_api.{{name}}.root_resource_id\n  path_part   = "{proxy+}"\n}\n\nresource "aws_api_gateway_method" "{{name}}" {\n  rest_api_id   = aws_api_gateway_rest_api.{{name}}.id\n  resource_id   = aws_api_gateway_resource.{{name}}.id\n  http_method   = "ANY"\n  authorization = "NONE"\n}\n\nresource "aws_api_gateway_deployment" "{{name}}" {\n  rest_api_id = aws_api_gateway_rest_api.{{name}}.id\n  stage_name  = "{{stage_name}}"\n\n  depends_on = [aws_api_gateway_method.{{name}}]\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN / GOVERNANCE (SysOps path)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ssm_parameter', 'SSM Parameter Store', 'Admin & Ops', 'PARAMETER',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_param","required":true},{"id":"param_name","label":"Parameter Name","type":"text","default":"/app/prod/db-host","required":true},{"id":"description","label":"Description","type":"text","default":"Application parameter"},{"id":"type","label":"Parameter Type","type":"select","options":["String","StringList","SecureString"],"default":"SecureString"},{"id":"value","label":"Value","type":"text","default":"placeholder-value"},{"id":"tier","label":"Tier","type":"select","options":["Standard","Advanced"],"default":"Standard"}]',
  'resource "aws_ssm_parameter" "{{name}}" {\n  name        = "{{param_name}}"\n  description = "{{description}}"\n  type        = "{{type}}"\n  value       = "{{value}}"\n  tier        = "{{tier}}"\n\n  tags = {\n    Name        = "{{param_name}}"\n    Environment = "{{environment}}"\n    ManagedBy   = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'aws_backup', 'AWS Backup Plan', 'Admin & Ops', 'BACKUP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_backup","required":true},{"id":"plan_name","label":"Backup Plan Name","type":"text","default":"daily-backup-plan","required":true},{"id":"schedule","label":"Backup Schedule (CRON)","type":"text","default":"cron(0 2 * * ? *)"},{"id":"delete_after","label":"Retention (days)","type":"number","default":"30"},{"id":"vault_name","label":"Backup Vault Name","type":"text","default":"my-backup-vault"},{"id":"target_resource_arn","label":"Target Resource ARN (optional)","type":"text","default":""}]',
  'resource "aws_backup_vault" "{{name}}" {\n  name = "{{vault_name}}"\n\n  tags = { Name = "{{vault_name}}", ManagedBy = "Terraform" }\n}\n\nresource "aws_backup_plan" "{{name}}" {\n  name = "{{plan_name}}"\n\n  rule {\n    rule_name         = "daily-backup"\n    target_vault_name = aws_backup_vault.{{name}}.name\n    schedule          = "{{schedule}}"\n\n    lifecycle {\n      delete_after = {{delete_after}}\n    }\n  }\n\n  tags = {\n    Name      = "{{plan_name}}"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_backup_selection" "{{name}}" {\n  iam_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/service-role/AWSBackupDefaultServiceRole"\n  name         = "{{plan_name}}-selection"\n  plan_id      = aws_backup_plan.{{name}}.id\n\n  selection_tag {\n    type  = "STRINGEQUALS"\n    key   = "Backup"\n    value = "true"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudtrail', 'CloudTrail', 'Admin & Ops', 'AUDIT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_trail","required":true},{"id":"trail_name","label":"Trail Name","type":"text","default":"management-events","required":true},{"id":"s3_bucket_name","label":"S3 Bucket for Logs","type":"text","default":"my-cloudtrail-logs","required":true},{"id":"include_global","label":"Include Global Service Events","type":"select","options":["true","false"],"default":"true"},{"id":"is_multi_region","label":"Multi-Region Trail","type":"select","options":["true","false"],"default":"true"},{"id":"log_validation","label":"Enable Log File Validation","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_s3_bucket" "{{name}}_logs" {\n  bucket        = "{{s3_bucket_name}}"\n  force_destroy = true\n\n  tags = { Name = "{{s3_bucket_name}}", ManagedBy = "Terraform" }\n}\n\nresource "aws_cloudtrail" "{{name}}" {\n  name                          = "{{trail_name}}"\n  s3_bucket_name                = aws_s3_bucket.{{name}}_logs.id\n  include_global_service_events = {{include_global}}\n  is_multi_region_trail         = {{is_multi_region}}\n  enable_log_file_validation    = {{log_validation}}\n\n  event_selector {\n    read_write_type           = "All"\n    include_management_events = true\n  }\n\n  tags = {\n    Name      = "{{trail_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'guardduty', 'GuardDuty', 'Admin & Ops', 'GUARD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_guardduty","required":true},{"id":"enabled","label":"Enabled","type":"select","options":["true","false"],"default":"true"},{"id":"finding_frequency","label":"Finding Publish Frequency","type":"select","options":["FIFTEEN_MINUTES","ONE_HOUR","SIX_HOURS"],"default":"ONE_HOUR"},{"id":"s3_logs","label":"Enable S3 Log Protection","type":"select","options":["true","false"],"default":"true"},{"id":"k8s_audit_logs","label":"Enable EKS Audit Logs","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_guardduty_detector" "{{name}}" {\n  enable = {{enabled}}\n\n  datasources {\n    s3_logs { enable = {{s3_logs}} }\n    kubernetes {\n      audit_logs { enable = {{k8s_audit_logs}} }\n    }\n    malware_protection {\n      scan_ec2_instance_with_findings {\n        ebs_volumes { enable = true }\n      }\n    }\n  }\n\n  finding_publishing_frequency = "{{finding_frequency}}"\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'waf', 'WAF Web ACL', 'Admin & Ops', 'WAF',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_waf","required":true},{"id":"acl_name","label":"Web ACL Name","type":"text","default":"my-waf-acl","required":true},{"id":"scope","label":"Scope","type":"select","options":["REGIONAL","CLOUDFRONT"],"default":"REGIONAL"},{"id":"default_action","label":"Default Action","type":"select","options":["allow","block"],"default":"allow"},{"id":"aws_managed_rules","label":"Enable AWS Managed Rules","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_wafv2_web_acl" "{{name}}" {\n  name  = "{{acl_name}}"\n  scope = "{{scope}}"\n\n  default_action {\n    {{default_action}} {}\n  }\n\n  rule {\n    name     = "AWSManagedRulesCommonRuleSet"\n    priority = 1\n\n    override_action { none {} }\n\n    statement {\n      managed_rule_group_statement {\n        name        = "AWSManagedRulesCommonRuleSet"\n        vendor_name = "AWS"\n      }\n    }\n\n    visibility_config {\n      cloudwatch_metrics_enabled = true\n      metric_name                = "AWSManagedRulesCommonRuleSetMetric"\n      sampled_requests_enabled   = true\n    }\n  }\n\n  visibility_config {\n    cloudwatch_metrics_enabled = true\n    metric_name                = "{{acl_name}}"\n    sampled_requests_enabled   = true\n  }\n\n  tags = {\n    Name      = "{{acl_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'budgets', 'AWS Budget', 'Admin & Ops', 'BUDGET',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_budget","required":true},{"id":"budget_name","label":"Budget Name","type":"text","default":"monthly-cost-budget","required":true},{"id":"limit_amount","label":"Budget Limit (USD)","type":"number","default":"100"},{"id":"time_unit","label":"Time Unit","type":"select","options":["MONTHLY","QUARTERLY","ANNUALLY","DAILY"],"default":"MONTHLY"},{"id":"budget_type","label":"Budget Type","type":"select","options":["COST","USAGE","SAVINGS_PLANS_UTILIZATION","RI_UTILIZATION"],"default":"COST"},{"id":"alert_threshold","label":"Alert Threshold (%)","type":"number","default":"80"},{"id":"email","label":"Notification Email","type":"text","default":"admin@example.com"}]',
  'resource "aws_budgets_budget" "{{name}}" {\n  name         = "{{budget_name}}"\n  budget_type  = "{{budget_type}}"\n  limit_amount = "{{limit_amount}}"\n  limit_unit   = "USD"\n  time_unit    = "{{time_unit}}"\n\n  notification {\n    comparison_operator        = "GREATER_THAN"\n    threshold                  = {{alert_threshold}}\n    threshold_type             = "PERCENTAGE"\n    notification_type          = "ACTUAL"\n    subscriber_email_addresses = ["{{email}}"]\n  }\n\n  notification {\n    comparison_operator        = "GREATER_THAN"\n    threshold                  = 100\n    threshold_type             = "PERCENTAGE"\n    notification_type          = "FORECASTED"\n    subscriber_email_addresses = ["{{email}}"]\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'config_rule', 'AWS Config Rule', 'Admin & Ops', 'CONFIG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_config","required":true},{"id":"rule_name","label":"Rule Name","type":"text","default":"s3-bucket-public-read-prohibited","required":true},{"id":"managed_rule","label":"AWS Managed Rule Identifier","type":"select","options":["S3_BUCKET_PUBLIC_READ_PROHIBITED","S3_BUCKET_VERSIONING_ENABLED","EC2_INSTANCE_NO_PUBLIC_IP","IAM_PASSWORD_POLICY","ROOT_ACCOUNT_MFA_ENABLED","ENCRYPTED_VOLUMES","RDS_STORAGE_ENCRYPTED","CLOUD_TRAIL_ENABLED"],"default":"S3_BUCKET_PUBLIC_READ_PROHIBITED"},{"id":"scope","label":"Resource Scope","type":"text","default":"AWS::S3::Bucket"}]',
  'resource "aws_config_configuration_recorder" "{{name}}" {\n  name     = "{{name}}-recorder"\n  role_arn = aws_iam_role.config_recorder.arn\n\n  recording_group {\n    all_supported = true\n  }\n}\n\nresource "aws_config_config_rule" "{{name}}" {\n  name = "{{rule_name}}"\n\n  source {\n    owner             = "AWS"\n    source_identifier = "{{managed_rule}}"\n  }\n\n  scope {\n    compliance_resource_types = ["{{scope}}"]\n  }\n\n  depends_on = [aws_config_configuration_recorder.{{name}}]\n\n  tags = {\n    Name      = "{{rule_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'transit_gateway', 'Transit Gateway', 'Admin & Ops', 'TRANSIT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_tgw","required":true},{"id":"description","label":"Description","type":"text","default":"Central hub for VPC connectivity"},{"id":"amazon_side_asn","label":"Amazon Side ASN","type":"number","default":"64512"},{"id":"auto_accept_shared","label":"Auto Accept Shared Attachments","type":"select","options":["disable","enable"],"default":"disable"},{"id":"dns_support","label":"DNS Support","type":"select","options":["enable","disable"],"default":"enable"},{"id":"vpn_ecmp_support","label":"VPN ECMP Support","type":"select","options":["enable","disable"],"default":"enable"}]',
  'resource "aws_ec2_transit_gateway" "{{name}}" {\n  description                     = "{{description}}"\n  amazon_side_asn                 = {{amazon_side_asn}}\n  auto_accept_shared_attachments  = "{{auto_accept_shared}}"\n  dns_support                     = "{{dns_support}}"\n  vpn_ecmp_support                = "{{vpn_ecmp_support}}"\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

