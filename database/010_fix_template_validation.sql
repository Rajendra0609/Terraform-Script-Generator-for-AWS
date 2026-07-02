-- =============================================================================
-- Migration 010: Fix template bodies that cause `terraform validate` failures
--
-- Root causes addressed:
--
--  1. NAT Gateway template: hardcoded `depends_on = [aws_internet_gateway.igw]`
--     referenced a resource (aws_internet_gateway.igw) that may not exist in the
--     user's project, causing "Reference to undeclared resource" errors.
--     Fix: remove the hard-coded depends_on; use self-referential EIP allocation.
--
--  2. config_rule template: `role_arn = aws_iam_role.config_recorder.arn`
--     referenced an IAM role that was never defined in the generated HCL, causing
--     "Reference to undeclared resource" errors.
--     Fix: define the IAM role (aws_config_configuration_recorder role) inline
--     within the config_rule template so it is self-contained.
--
--  3. NAT Gateway template: `allocation_id = {{allocation_id}}` defaulted to
--     `aws_eip.nat.id` (a literal string reference that may not exist).
--     Fix: the template now defines `resource "aws_eip" "{{name}}"` and uses
--     `allocation_id = aws_eip.{{name}}.id` so the block is self-contained.
-- =============================================================================

-- ── 1. NAT Gateway ────────────────────────────────────────────────────────────
UPDATE templates
SET
  schema_def    = '[{"id":"name","label":"Resource Name","type":"text","default":"my_nat","required":true},{"id":"subnet_id","label":"Subnet ID / Reference (Public Subnet)","type":"text","default":"aws_subnet.public_a.id","required":true},{"id":"allocation_id","label":"EIP Allocation ID / Reference (leave blank to auto-create)","type":"text","default":""}]',
  template_body = 'resource "aws_eip" "{{name}}" {\n  domain = "vpc"\n  tags = { Name = "{{name}}-eip" }\n}\n\nresource "aws_nat_gateway" "{{name}}" {\n  allocation_id = aws_eip.{{name}}.id\n  subnet_id     = {{subnet_id}}\n\n  tags = {\n    Name      = "{{name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  updated_at    = NOW()
WHERE service_type = 'nat_gateway';

-- ── 2. Config Rule ────────────────────────────────────────────────────────────
UPDATE templates
SET
  template_body = 'resource "aws_iam_role" "{{name}}_config" {\n  name = "{{name}}-config-recorder-role"\n\n  assume_role_policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Action    = "sts:AssumeRole"\n      Effect    = "Allow"\n      Principal = { Service = "config.amazonaws.com" }\n    }]\n  })\n\n  tags = {\n    Name      = "{{name}}-config-role"\n    ManagedBy = "Terraform"\n  }\n}\n\nresource "aws_iam_role_policy_attachment" "{{name}}_config" {\n  role       = aws_iam_role.{{name}}_config.name\n  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"\n}\n\nresource "aws_config_configuration_recorder" "{{name}}" {\n  name     = "{{name}}-recorder"\n  role_arn = aws_iam_role.{{name}}_config.arn\n\n  recording_group {\n    all_supported = true\n  }\n}\n\nresource "aws_config_config_rule" "{{name}}" {\n  name = "{{rule_name}}"\n\n  source {\n    owner             = "AWS"\n    source_identifier = "{{managed_rule}}"\n  }\n\n  scope {\n    compliance_resource_types = ["{{scope}}"]\n  }\n\n  depends_on = [aws_config_configuration_recorder.{{name}}]\n\n  tags = {\n    Name      = "{{rule_name}}"\n    ManagedBy = "Terraform"\n  }\n}',
  updated_at    = NOW()
WHERE service_type = 'config_rule';

-- ── 3. Record migration ───────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename)
VALUES ('010', '010_fix_template_validation.sql')
ON CONFLICT (version) DO NOTHING;
