-- ==============================================================
-- migrations.sql
-- Combined migration file for TFGen (v1 -> v9 + ownership fix)
-- Run in order against an existing database.
-- ==============================================================


-- ------------------------------------------------------------
-- SOURCE: migrate.sql
-- ------------------------------------------------------------

-- ─── TFGen: Safe incremental migration ────────────────────────────────────────
-- Run this against an EXISTING database to add all columns introduced in
-- Phase-2, Phase-3, and Phase-4 without dropping any data.
--
-- Usage:
--   psql "$DATABASE_URL" -f database/migrate.sql
--
-- This file is idempotent — running it multiple times is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pgcrypto if not already enabled (needed for gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── users ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'users: %', SQLERRM; END
$$;

-- ─── projects ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment    VARCHAR(50) DEFAULT 'dev';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS backend_config JSONB       DEFAULT '{}';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id        UUID;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'projects: %', SQLERRM; END
$$;

-- ─── resources ───────────────────────────────────────────────────────────────
-- CRITICAL: lifecycle_config is required by POST /api/projects/:id/resources
DO $$
BEGIN
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS variables        JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS outputs          JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS module_source    VARCHAR(500);
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_module        BOOLEAN DEFAULT false;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS lifecycle_config JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_x       NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_y       NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS annotations      TEXT    DEFAULT '';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS security_findings JSONB  DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'resources: %', SQLERRM; END
$$;

-- ─── project_versions ────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS variables_hcl     TEXT;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS outputs_hcl        TEXT;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd  NUMERIC(12,4);
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed      INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed      INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_graph_json JSONB;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by            UUID;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary      TEXT DEFAULT '';
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count      INT DEFAULT 0;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'project_versions: %', SQLERRM; END
$$;

-- ─── templates ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE templates ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'templates: %', SQLERRM; END
$$;

-- ─── New tables (safe: CREATE IF NOT EXISTS) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT      NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked    BOOLEAN   DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS project_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id)  ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id)     ON DELETE CASCADE,
  role        VARCHAR(50) DEFAULT 'viewer',
  invited_by  UUID REFERENCES users(id),
  invited_at  TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user    ON project_members(user_id);

CREATE TABLE IF NOT EXISTS user_aws_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  aws_region      VARCHAR(50)  NOT NULL DEFAULT 'ap-south-1',
  access_key_id   TEXT         NOT NULL,
  secret_key_enc  TEXT         NOT NULL,
  label           VARCHAR(255) DEFAULT 'My AWS Account',
  verified_at     TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aws_creds_user ON user_aws_credentials(user_id);

CREATE TABLE IF NOT EXISTS lab_progress (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  lab_id     VARCHAR(50) NOT NULL,
  step_id    INT         NOT NULL,
  completed  BOOLEAN     DEFAULT true,
  updated_at TIMESTAMP   DEFAULT NOW(),
  UNIQUE(user_id, lab_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_lab_progress_user ON lab_progress(user_id, lab_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  method      VARCHAR(10),
  path        TEXT,
  ip          VARCHAR(45),
  meta        JSONB   DEFAULT '{}',
  status_code INT,
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS execution_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id)    ON DELETE SET NULL,
  type            VARCHAR(50)  NOT NULL,
  status          VARCHAR(50)  DEFAULT 'queued',
  hcl_hash        VARCHAR(64),
  plan_summary    JSONB DEFAULT '{}',
  cost_delta      NUMERIC(12,4),
  checkov_summary JSONB DEFAULT '{}',
  log_key         TEXT,
  error           TEXT,
  queued_at       TIMESTAMP DEFAULT NOW(),
  started_at      TIMESTAMP,
  finished_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_project ON execution_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_exec_jobs_status  ON execution_jobs(status);

\echo 'Migration complete — all columns and tables are up to date.'


-- ------------------------------------------------------------
-- SOURCE: migrate_v5_columns.sql
-- ------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────────
-- TFGen v5 — one-time migration: add missing columns to project_versions
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
--
-- Usage:
--   psql "$DATABASE_URL" -f database/migrate_v5_columns.sql
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,4);
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed     INT          DEFAULT 0;
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed     INT          DEFAULT 0;
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary     TEXT         DEFAULT '';
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by           UUID;
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count     INT          DEFAULT 0;

-- Add a foreign-key constraint on saved_by only if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'project_versions'
      AND constraint_name = 'project_versions_saved_by_fkey'
  ) THEN
    ALTER TABLE project_versions
      ADD CONSTRAINT project_versions_saved_by_fkey
      FOREIGN KEY (saved_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping saved_by FK: %', SQLERRM;
END $$;

-- Confirm
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'project_versions'
ORDER BY ordinal_position;


-- ------------------------------------------------------------
-- SOURCE: migrate_v6.sql
-- ------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────────
-- One-time admin fix: make tfgen the owner of public.project_versions
-- Run as: postgres (or superuser)
--
-- Usage examples:
--   sudo -u postgres psql -d terraform_generator -f database/fix_project_versions_owner.sql
--   psql -U postgres -h localhost -d terraform_generator -f database/fix_project_versions_owner.sql
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

DO $$
DECLARE
  tbl_owner text;
BEGIN
  -- Ensure tfgen role exists
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tfgen') THEN
    RAISE EXCEPTION 'Role "tfgen" does not exist. Create it first, then re-run.';
  END IF;

  -- Identify current owner
  SELECT r.rolname INTO tbl_owner
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'project_versions'
    AND c.relkind = 'r';

  IF tbl_owner IS NULL THEN
    RAISE EXCEPTION 'Table public.project_versions does not exist.';
  END IF;

  RAISE NOTICE 'Current owner of public.project_versions = %', tbl_owner;
END $$;

-- Transfer ownership (requires postgres/superuser or current table owner)
ALTER TABLE public.project_versions OWNER TO tfgen;

-- Confirm
SELECT n.nspname AS schema, c.relname AS table, r.rolname AS owner
FROM pg_class c
JOIN pg_roles r ON r.oid = c.relowner
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relname='project_versions' AND c.relkind='r';


-- ------------------------------------------------------------
-- SOURCE: migrate_v7.sql
-- ------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v7: persist last_hcl on projects + ensure resource JSONB columns
--
-- Run as the DB owner / superuser:
--   psql -U tfgen -d terraform_generator -f database/migrate_v7.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add last_hcl to projects so the full Terraform code is always recoverable
--    even when the detailed resource rows are empty or stale.
--    Note: this may fail if the migration user is not the table owner.
DO $$
BEGIN
  BEGIN
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS last_hcl TEXT DEFAULT '';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping projects.last_hcl column migration: insufficient privilege';
  END;
END $$;

-- 2. Ensure every JSONB column the save endpoint writes actually exists.
--    Using ADD COLUMN IF NOT EXISTS is idempotent — safe to re-run.
DO $$
BEGIN
  -- resources table: JSONB columns
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS variables         JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS outputs           JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS lifecycle_config  JSONB   DEFAULT '{}';
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS security_findings JSONB   DEFAULT '[]';
  -- resources table: canvas position
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_x        NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_y        NUMERIC DEFAULT 0;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS annotations       TEXT    DEFAULT '';
  -- resources table: module support
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_module         BOOLEAN DEFAULT false;
  ALTER TABLE resources ADD COLUMN IF NOT EXISTS module_source     VARCHAR(500) DEFAULT '';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping resources column migration: insufficient privilege';
END $$;

-- 3. Ensure project_versions has all extended columns
DO $$
BEGIN
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,4);
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed     INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed     INT DEFAULT 0;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary     TEXT DEFAULT '';
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by           UUID;
  ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count     INT DEFAULT 0;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping project_versions column migration: insufficient privilege';
END $$;

-- 4. Back-fill last_hcl from the latest version snapshot for existing projects
--    Only run if projects.last_hcl exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'projects'
      AND column_name = 'last_hcl'
  ) THEN
    UPDATE projects p
    SET    last_hcl = pv.full_hcl
    FROM (
      SELECT DISTINCT ON (project_id)
             project_id, full_hcl
      FROM   project_versions
      WHERE  full_hcl IS NOT NULL AND full_hcl <> ''
      ORDER  BY project_id, version_number DESC
    ) pv
    WHERE p.id = pv.project_id
      AND (p.last_hcl IS NULL OR p.last_hcl = '');
  ELSE
    RAISE NOTICE 'Skipping backfill: projects.last_hcl column does not exist';
  END IF;
END $$;



-- ------------------------------------------------------------
-- SOURCE: migrate_v8_more_services.sql
-- ------------------------------------------------------------

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


-- ------------------------------------------------------------
-- SOURCE: migrate_v9_missing_services.sql
-- ------------------------------------------------------------

-- ═══════════════════════════════════════════════════════════════════════════
-- migrate_v9_missing_services.sql
-- Adds ~81 missing AWS services across all categories:
-- Route 53, Load Balancing, Compute, Containers, Storage, Database,
-- IAM & Security, CI/CD, Monitoring, Analytics, App Integration,
-- Infrastructure & Governance, Machine Learning
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ROUTE 53
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'route53_record', 'Route53 DNS Record', 'Networking', 'DNS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_record","required":true},{"id":"zone_id","label":"Hosted Zone ID / Ref","type":"text","default":"aws_route53_zone.main.zone_id","required":true},{"id":"record_name","label":"Record Name (FQDN)","type":"text","default":"app.example.com","required":true},{"id":"record_type","label":"Record Type","type":"select","options":["A","AAAA","CNAME","MX","TXT","NS","SRV","CAA"],"default":"A"},{"id":"ttl","label":"TTL (seconds)","type":"number","default":"300"},{"id":"records","label":"Record Values (comma-sep)","type":"text","default":"\"1.2.3.4\""}]',
  'resource "aws_route53_record" "{{name}}" {
  zone_id = {{zone_id}}
  name    = "{{record_name}}"
  type    = "{{record_type}}"
  ttl     = {{ttl}}
  records = [{{records}}]
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'route53_resolver_endpoint', 'Route53 Resolver Endpoint', 'Networking', 'RDNS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_resolver","required":true},{"id":"direction","label":"Direction","type":"select","options":["INBOUND","OUTBOUND"],"default":"OUTBOUND"},{"id":"security_group_ids","label":"Security Group IDs (comma-sep)","type":"text","default":"aws_security_group.resolver.id","required":true},{"id":"subnet_id_1","label":"Subnet ID 1","type":"text","default":"aws_subnet.private_a.id","required":true},{"id":"subnet_id_2","label":"Subnet ID 2","type":"text","default":"aws_subnet.private_b.id","required":true}]',
  'resource "aws_route53_resolver_endpoint" "{{name}}" {
  name      = "{{name}}"
  direction = "{{direction}}"

  security_group_ids = [{{security_group_ids}}]

  ip_address {
    subnet_id = {{subnet_id_1}}
  }

  ip_address {
    subnet_id = {{subnet_id_2}}
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
  'route53_resolver_rule', 'Route53 Resolver Rule', 'Networking', 'RRULE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_resolver_rule","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"corp.example.com","required":true},{"id":"rule_type","label":"Rule Type","type":"select","options":["FORWARD","SYSTEM","RECURSIVE"],"default":"FORWARD"},{"id":"resolver_endpoint_id","label":"Resolver Endpoint ID / Ref","type":"text","default":"aws_route53_resolver_endpoint.outbound.id"},{"id":"target_ip","label":"Target DNS IP","type":"text","default":"10.0.0.2"},{"id":"target_port","label":"Target Port","type":"number","default":"53"}]',
  'resource "aws_route53_resolver_rule" "{{name}}" {
  name                 = "{{name}}"
  domain_name          = "{{domain_name}}"
  rule_type            = "{{rule_type}}"
  resolver_endpoint_id = {{resolver_endpoint_id}}

  target_ip {
    ip   = "{{target_ip}}"
    port = {{target_port}}
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
  'route53_traffic_policy', 'Route53 Traffic Policy', 'Networking', 'R53TP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_traffic_policy","required":true},{"id":"policy_name","label":"Traffic Policy Name","type":"text","default":"my-routing-policy","required":true},{"id":"comment","label":"Comment","type":"text","default":"Managed by Terraform"}]',
  'resource "aws_route53_traffic_policy" "{{name}}" {
  name    = "{{policy_name}}"
  comment = "{{comment}}"
  document = jsonencode({
    AWSPolicyFormatVersion = "2015-10-01"
    RecordType = "A"
    Endpoints = {
      ep1 = { Type = "value", Value = "1.2.3.4" }
    }
    StartEndpoint = "ep1"
  })
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- LOAD BALANCING
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'alb_target_group', 'ALB Target Group', 'Networking', 'TG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_tg","required":true},{"id":"tg_name","label":"Target Group Name","type":"text","default":"my-app-tg","required":true},{"id":"port","label":"Port","type":"number","default":"80"},{"id":"protocol","label":"Protocol","type":"select","options":["HTTP","HTTPS","TCP","TLS","UDP"],"default":"HTTP"},{"id":"target_type","label":"Target Type","type":"select","options":["instance","ip","lambda","alb"],"default":"ip"},{"id":"vpc_id","label":"VPC ID / Reference","type":"text","default":"aws_vpc.my_vpc.id","required":true},{"id":"health_check_path","label":"Health Check Path","type":"text","default":"/health"},{"id":"deregistration_delay","label":"Deregistration Delay (s)","type":"number","default":"30"}]',
  'resource "aws_lb_target_group" "{{name}}" {
  name                 = "{{tg_name}}"
  port                 = {{port}}
  protocol             = "{{protocol}}"
  target_type          = "{{target_type}}"
  vpc_id               = {{vpc_id}}
  deregistration_delay = {{deregistration_delay}}

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 30
    path                = "{{health_check_path}}"
    protocol            = "{{protocol}}"
  }

  tags = {
    Name      = "{{tg_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'alb_listener', 'ALB Listener', 'Networking', 'LSTN',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_listener","required":true},{"id":"lb_arn","label":"Load Balancer ARN / Ref","type":"text","default":"aws_lb.my_alb.arn","required":true},{"id":"port","label":"Port","type":"number","default":"443"},{"id":"protocol","label":"Protocol","type":"select","options":["HTTP","HTTPS","TCP","TLS"],"default":"HTTPS"},{"id":"certificate_arn","label":"ACM Certificate ARN (HTTPS)","type":"text","default":""},{"id":"target_group_arn","label":"Default Target Group ARN / Ref","type":"text","default":"aws_lb_target_group.my_tg.arn","required":true},{"id":"ssl_policy","label":"SSL Policy","type":"select","options":["ELBSecurityPolicy-TLS13-1-2-2021-06","ELBSecurityPolicy-2016-08","ELBSecurityPolicy-FS-1-2-Res-2020-10"],"default":"ELBSecurityPolicy-TLS13-1-2-2021-06"}]',
  'resource "aws_lb_listener" "{{name}}" {
  load_balancer_arn = {{lb_arn}}
  port              = {{port}}
  protocol          = "{{protocol}}"
  ssl_policy        = "{{ssl_policy}}"
  certificate_arn   = "{{certificate_arn}}"

  default_action {
    type             = "forward"
    target_group_arn = {{target_group_arn}}
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'alb_listener_rule', 'ALB Listener Rule', 'Networking', 'LRULE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_listener_rule","required":true},{"id":"listener_arn","label":"Listener ARN / Ref","type":"text","default":"aws_lb_listener.my_listener.arn","required":true},{"id":"priority","label":"Rule Priority","type":"number","default":"100"},{"id":"path_pattern","label":"Path Pattern","type":"text","default":"/api/*"},{"id":"target_group_arn","label":"Target Group ARN / Ref","type":"text","default":"aws_lb_target_group.my_tg.arn","required":true}]',
  'resource "aws_lb_listener_rule" "{{name}}" {
  listener_arn = {{listener_arn}}
  priority     = {{priority}}

  action {
    type             = "forward"
    target_group_arn = {{target_group_arn}}
  }

  condition {
    path_pattern {
      values = ["{{path_pattern}}"]
    }
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'gateway_load_balancer', 'Gateway Load Balancer', 'Networking', 'GWLB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_gwlb","required":true},{"id":"gwlb_name","label":"GWLB Name","type":"text","default":"my-gateway-lb","required":true},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id","required":true},{"id":"enable_cross_zone","label":"Cross-Zone Load Balancing","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_lb" "{{name}}" {
  name               = "{{gwlb_name}}"
  load_balancer_type = "gateway"
  subnets            = [{{subnet_ids}}]

  enable_cross_zone_load_balancing = {{enable_cross_zone}}

  tags = {
    Name      = "{{gwlb_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_lb_target_group" "{{name}}" {
  name        = "{{gwlb_name}}-tg"
  port        = 6081
  protocol    = "GENEVE"
  vpc_id      = aws_lb.{{name}}.vpc_id
  target_type = "instance"

  health_check {
    port     = 80
    protocol = "HTTP"
  }

  tags = { ManagedBy = "Terraform" }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMPUTE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'key_pair', 'EC2 Key Pair', 'Compute', 'KEY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_key_pair","required":true},{"id":"key_name","label":"Key Pair Name","type":"text","default":"my-app-key","required":true},{"id":"public_key","label":"Public Key Material","type":"text","default":"ssh-rsa AAAA...","required":true}]',
  'resource "aws_key_pair" "{{name}}" {
  key_name   = "{{key_name}}"
  public_key = "{{public_key}}"

  tags = {
    Name      = "{{key_name}}"
    ManagedBy = "Terraform"
  }
}

output "{{name}}_key_name" {
  value = aws_key_pair.{{name}}.key_name
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'image_builder_pipeline', 'EC2 Image Builder Pipeline', 'Compute', 'IMGB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_image_pipeline","required":true},{"id":"pipeline_name","label":"Pipeline Name","type":"text","default":"golden-ami-pipeline","required":true},{"id":"image_recipe_arn","label":"Image Recipe ARN / Ref","type":"text","default":"aws_imagebuilder_image_recipe.main.arn","required":true},{"id":"infrastructure_arn","label":"Infrastructure Config ARN / Ref","type":"text","default":"aws_imagebuilder_infrastructure_configuration.main.arn","required":true},{"id":"schedule_expression","label":"Cron Schedule","type":"text","default":"cron(0 0 * * ? *)"},{"id":"status","label":"Status","type":"select","options":["ENABLED","DISABLED"],"default":"ENABLED"}]',
  'resource "aws_imagebuilder_image_pipeline" "{{name}}" {
  name                             = "{{pipeline_name}}"
  image_recipe_arn                 = {{image_recipe_arn}}
  infrastructure_configuration_arn = {{infrastructure_arn}}
  status                           = "{{status}}"

  schedule {
    schedule_expression = "{{schedule_expression}}"
  }

  tags = {
    Name      = "{{pipeline_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'apprunner_service', 'AWS App Runner Service', 'Compute', 'APPR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_apprunner","required":true},{"id":"service_name","label":"Service Name","type":"text","default":"my-app-runner","required":true},{"id":"image_identifier","label":"Container Image URI","type":"text","default":"public.ecr.aws/nginx/nginx:latest","required":true},{"id":"image_repository_type","label":"Image Repository Type","type":"select","options":["ECR","ECR_PUBLIC"],"default":"ECR_PUBLIC"},{"id":"cpu","label":"CPU (vCPU)","type":"select","options":["0.25","0.5","1","2","4"],"default":"0.5"},{"id":"memory","label":"Memory (GB)","type":"select","options":["0.5","1","2","3","4","6","8"],"default":"1"},{"id":"port","label":"Container Port","type":"number","default":"8080"}]',
  'resource "aws_apprunner_service" "{{name}}" {
  service_name = "{{service_name}}"

  source_configuration {
    image_repository {
      image_identifier      = "{{image_identifier}}"
      image_repository_type = "{{image_repository_type}}"

      image_configuration {
        port = "{{port}}"
      }
    }
    auto_deployments_enabled = true
  }

  instance_configuration {
    cpu    = "{{cpu}} vCPU"
    memory = "{{memory}} GB"
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
  'batch_compute_environment', 'AWS Batch Compute Environment', 'Compute', 'BATCH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_batch","required":true},{"id":"compute_env_name","label":"Compute Environment Name","type":"text","default":"my-batch-compute","required":true},{"id":"max_vcpus","label":"Max vCPUs","type":"number","default":"256"},{"id":"min_vcpus","label":"Min vCPUs","type":"number","default":"0"},{"id":"instance_type","label":"Instance Type","type":"text","default":"m5.large"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id"},{"id":"security_group_ids","label":"Security Group IDs (comma-sep)","type":"text","default":"aws_security_group.batch.id"},{"id":"service_role_arn","label":"Service Role ARN / Ref","type":"text","default":"aws_iam_role.batch_service.arn"}]',
  'resource "aws_batch_compute_environment" "{{name}}" {
  compute_environment_name = "{{compute_env_name}}"
  type                     = "MANAGED"
  service_role             = {{service_role_arn}}

  compute_resources {
    type               = "EC2"
    max_vcpus          = {{max_vcpus}}
    min_vcpus          = {{min_vcpus}}
    instance_type      = ["{{instance_type}}"]
    subnets            = [{{subnet_ids}}]
    security_group_ids = [{{security_group_ids}}]
    instance_role      = aws_iam_instance_profile.ecs_instance.arn
  }

  tags = {
    Name      = "{{compute_env_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_batch_job_queue" "{{name}}" {
  name     = "{{compute_env_name}}-queue"
  state    = "ENABLED"
  priority = 1

  compute_environments = [
    aws_batch_compute_environment.{{name}}.arn
  ]
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'lambda_layer_version', 'Lambda Layer', 'Compute', 'LLYR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_layer","required":true},{"id":"layer_name","label":"Layer Name","type":"text","default":"my-shared-layer","required":true},{"id":"description","label":"Description","type":"text","default":"Shared dependencies"},{"id":"compatible_runtimes","label":"Compatible Runtimes (comma-sep)","type":"text","default":"\"python3.11\", \"python3.12\""},{"id":"s3_bucket","label":"S3 Bucket for Layer ZIP","type":"text","default":"my-deployment-bucket"},{"id":"s3_key","label":"S3 Key for Layer ZIP","type":"text","default":"layers/my-layer.zip"}]',
  'resource "aws_lambda_layer_version" "{{name}}" {
  layer_name          = "{{layer_name}}"
  description         = "{{description}}"
  compatible_runtimes = [{{compatible_runtimes}}]

  s3_bucket = "{{s3_bucket}}"
  s3_key    = "{{s3_key}}"
}

output "{{name}}_arn" {
  value = aws_lambda_layer_version.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'lambda_function_url', 'Lambda Function URL', 'Compute', 'LURL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_function_url","required":true},{"id":"function_name","label":"Lambda Function Name / Ref","type":"text","default":"aws_lambda_function.my_fn.function_name","required":true},{"id":"auth_type","label":"Auth Type","type":"select","options":["NONE","AWS_IAM"],"default":"AWS_IAM"},{"id":"invoke_mode","label":"Invoke Mode","type":"select","options":["BUFFERED","RESPONSE_STREAM"],"default":"BUFFERED"}]',
  'resource "aws_lambda_function_url" "{{name}}" {
  function_name      = {{function_name}}
  authorization_type = "{{auth_type}}"
  invoke_mode        = "{{invoke_mode}}"

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers     = ["Content-Type", "Authorization"]
    max_age           = 3600
  }
}

output "{{name}}_url" {
  value = aws_lambda_function_url.{{name}}.function_url
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'lambda_event_source_mapping', 'Lambda Event Source Mapping', 'Compute', 'LESM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_esm","required":true},{"id":"event_source_arn","label":"Event Source ARN / Ref (SQS/Kinesis/DDB)","type":"text","default":"aws_sqs_queue.my_queue.arn","required":true},{"id":"function_name","label":"Lambda Function Name / Ref","type":"text","default":"aws_lambda_function.my_fn.function_name","required":true},{"id":"batch_size","label":"Batch Size","type":"number","default":"10"},{"id":"enabled","label":"Enabled","type":"select","options":["true","false"],"default":"true"},{"id":"bisect_on_error","label":"Bisect Batch On Error","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_lambda_event_source_mapping" "{{name}}" {
  event_source_arn               = {{event_source_arn}}
  function_name                  = {{function_name}}
  batch_size                     = {{batch_size}}
  enabled                        = {{enabled}}
  bisect_batch_on_function_error = {{bisect_on_error}}
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTAINERS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eks_addon', 'EKS Add-on', 'Containers', 'EKSAD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_eks_addon","required":true},{"id":"cluster_name","label":"EKS Cluster Name / Ref","type":"text","default":"aws_eks_cluster.main.name","required":true},{"id":"addon_name","label":"Add-on Name","type":"select","options":["vpc-cni","coredns","kube-proxy","aws-ebs-csi-driver","aws-efs-csi-driver","amazon-cloudwatch-observability"],"default":"vpc-cni"},{"id":"resolve_conflicts","label":"Resolve Conflicts","type":"select","options":["OVERWRITE","NONE","PRESERVE"],"default":"OVERWRITE"}]',
  'resource "aws_eks_addon" "{{name}}" {
  cluster_name                = {{cluster_name}}
  addon_name                  = "{{addon_name}}"
  resolve_conflicts_on_update = "{{resolve_conflicts}}"

  tags = {
    Name      = "{{addon_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'appmesh_mesh', 'AWS App Mesh', 'Containers', 'MESH',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_mesh","required":true},{"id":"mesh_name","label":"Mesh Name","type":"text","default":"my-service-mesh","required":true},{"id":"egress_filter","label":"Egress Filter","type":"select","options":["ALLOW_ALL","DROP_ALL"],"default":"ALLOW_ALL"}]',
  'resource "aws_appmesh_mesh" "{{name}}" {
  name = "{{mesh_name}}"

  spec {
    egress_filter {
      type = "{{egress_filter}}"
    }
  }

  tags = {
    Name      = "{{mesh_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_appmesh_virtual_router" "{{name}}" {
  name      = "{{mesh_name}}-router"
  mesh_name = aws_appmesh_mesh.{{name}}.id

  spec {
    listener {
      port_mapping {
        port     = 8080
        protocol = "http"
      }
    }
  }

  tags = { ManagedBy = "Terraform" }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecr_lifecycle_policy', 'ECR Lifecycle Policy', 'Containers', 'ECRLP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ecr_lifecycle","required":true},{"id":"repository","label":"ECR Repository Name / Ref","type":"text","default":"aws_ecr_repository.my_repo.name","required":true},{"id":"max_image_count","label":"Max Tagged Images to Keep","type":"number","default":"30"},{"id":"untagged_expire_days","label":"Untagged Image Expiry (days)","type":"number","default":"7"}]',
  'resource "aws_ecr_lifecycle_policy" "{{name}}" {
  repository = {{repository}}

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = {{untagged_expire_days}}
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last N tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = {{max_image_count}}
        }
        action = { type = "expire" }
      }
    ]
  })
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecs_capacity_provider', 'ECS Capacity Provider', 'Containers', 'ECSCP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_capacity_provider","required":true},{"id":"provider_name","label":"Capacity Provider Name","type":"text","default":"my-cp","required":true},{"id":"asg_arn","label":"Auto Scaling Group ARN / Ref","type":"text","default":"aws_autoscaling_group.ecs.arn","required":true},{"id":"managed_scaling","label":"Managed Scaling","type":"select","options":["ENABLED","DISABLED"],"default":"ENABLED"},{"id":"target_capacity","label":"Target Capacity %","type":"number","default":"80"},{"id":"min_scaling_step","label":"Min Scaling Step Size","type":"number","default":"1"},{"id":"max_scaling_step","label":"Max Scaling Step Size","type":"number","default":"10"}]',
  'resource "aws_ecs_capacity_provider" "{{name}}" {
  name = "{{provider_name}}"

  auto_scaling_group_provider {
    auto_scaling_group_arn = {{asg_arn}}

    managed_scaling {
      status                    = "{{managed_scaling}}"
      target_capacity           = {{target_capacity}}
      minimum_scaling_step_size = {{min_scaling_step}}
      maximum_scaling_step_size = {{max_scaling_step}}
    }
  }

  tags = {
    Name      = "{{provider_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'eks_identity_provider_config', 'EKS OIDC Identity Provider', 'Containers', 'EKSIDP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_eks_oidc","required":true},{"id":"cluster_name","label":"EKS Cluster Name / Ref","type":"text","default":"aws_eks_cluster.main.name","required":true},{"id":"client_id","label":"OIDC Client ID","type":"text","default":"sts.amazonaws.com","required":true},{"id":"issuer_url","label":"OIDC Issuer URL","type":"text","default":"https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE","required":true},{"id":"identity_provider_name","label":"Identity Provider Name","type":"text","default":"my-oidc-provider"},{"id":"username_claim","label":"Username Claim","type":"text","default":"email"},{"id":"groups_claim","label":"Groups Claim","type":"text","default":"groups"}]',
  'resource "aws_eks_identity_provider_config" "{{name}}" {
  cluster_name = {{cluster_name}}

  oidc {
    client_id                     = "{{client_id}}"
    issuer_url                    = "{{issuer_url}}"
    identity_provider_config_name = "{{identity_provider_name}}"
    username_claim                = "{{username_claim}}"
    groups_claim                  = "{{groups_claim}}"
  }

  tags = {
    Name      = "{{identity_provider_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  's3_bucket_policy', 'S3 Bucket Policy', 'Storage', 'S3POL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_bucket_policy","required":true},{"id":"bucket","label":"Bucket Name / Ref","type":"text","default":"aws_s3_bucket.my_bucket.id","required":true},{"id":"effect","label":"Effect","type":"select","options":["Allow","Deny"],"default":"Deny"},{"id":"principal","label":"Principal","type":"text","default":"*"},{"id":"actions","label":"Actions (comma-sep)","type":"text","default":"s3:GetObject"},{"id":"condition_key","label":"Condition Key","type":"text","default":"aws:SecureTransport"},{"id":"condition_value","label":"Condition Value","type":"text","default":"false"}]',
  'resource "aws_s3_bucket_policy" "{{name}}" {
  bucket = {{bucket}}

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforcePolicy"
        Effect    = "{{effect}}"
        Principal = "{{principal}}"
        Action    = split(",", trimspace("{{actions}}"))
        Resource  = ["arn:aws:s3:::${{{bucket}}}/*", "arn:aws:s3:::${{{bucket}}}"]
        Condition = {
          Bool = {
            "{{condition_key}}" = "{{condition_value}}"
          }
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
  'transfer_server', 'AWS Transfer Family (SFTP)', 'Storage', 'SFTP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sftp","required":true},{"id":"protocol","label":"Protocol","type":"select","options":["SFTP","FTPS","FTP"],"default":"SFTP"},{"id":"identity_provider","label":"Identity Provider","type":"select","options":["SERVICE_MANAGED","API_GATEWAY","AWS_DIRECTORY_SERVICE","AWS_LAMBDA"],"default":"SERVICE_MANAGED"},{"id":"endpoint_type","label":"Endpoint Type","type":"select","options":["PUBLIC","VPC"],"default":"PUBLIC"},{"id":"logging_role_arn","label":"CloudWatch Logging Role ARN / Ref","type":"text","default":"aws_iam_role.transfer_logging.arn"}]',
  'resource "aws_transfer_server" "{{name}}" {
  protocols              = ["{{protocol}}"]
  identity_provider_type = "{{identity_provider}}"
  endpoint_type          = "{{endpoint_type}}"
  logging_role           = {{logging_role_arn}}

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}

output "{{name}}_endpoint" {
  value = aws_transfer_server.{{name}}.endpoint
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'backup_vault', 'AWS Backup Vault', 'Storage', 'BKPV',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_backup_vault","required":true},{"id":"vault_name","label":"Vault Name","type":"text","default":"my-backup-vault","required":true},{"id":"kms_key_arn","label":"KMS Key ARN / Ref","type":"text","default":"aws_kms_key.backup.arn"},{"id":"force_destroy","label":"Force Destroy","type":"select","options":["true","false"],"default":"false"}]',
  'resource "aws_backup_vault" "{{name}}" {
  name          = "{{vault_name}}"
  kms_key_arn   = {{kms_key_arn}}
  force_destroy = {{force_destroy}}

  tags = {
    Name      = "{{vault_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_backup_vault_notifications" "{{name}}" {
  backup_vault_name   = aws_backup_vault.{{name}}.name
  sns_topic_arn       = aws_sns_topic.backup_alerts.arn
  backup_vault_events = ["BACKUP_JOB_FAILED", "RESTORE_JOB_FAILED"]
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'storage_gateway', 'AWS Storage Gateway', 'Storage', 'SGW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_storage_gateway","required":true},{"id":"gateway_name","label":"Gateway Name","type":"text","default":"my-storage-gw","required":true},{"id":"gateway_timezone","label":"Timezone","type":"text","default":"GMT"},{"id":"gateway_type","label":"Gateway Type","type":"select","options":["FILE_S3","FILE_FSX_SMB","STORED","CACHED","VTL"],"default":"FILE_S3"},{"id":"activation_key","label":"Activation Key","type":"text","default":""}]',
  'resource "aws_storagegateway_gateway" "{{name}}" {
  gateway_name     = "{{gateway_name}}"
  gateway_timezone = "{{gateway_timezone}}"
  gateway_type     = "{{gateway_type}}"
  activation_key   = "{{activation_key}}"

  tags = {
    Name      = "{{gateway_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- DATABASE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'db_subnet_group', 'RDS Subnet Group', 'Database', 'DBSNG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_db_subnet_group","required":true},{"id":"group_name","label":"Subnet Group Name","type":"text","default":"my-db-subnet-group","required":true},{"id":"description","label":"Description","type":"text","default":"RDS subnet group"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id","required":true}]',
  'resource "aws_db_subnet_group" "{{name}}" {
  name        = "{{group_name}}"
  description = "{{description}}"
  subnet_ids  = [{{subnet_ids}}]

  tags = {
    Name      = "{{group_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'db_parameter_group', 'RDS Parameter Group', 'Database', 'DBPG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_db_parameter_group","required":true},{"id":"group_name","label":"Parameter Group Name","type":"text","default":"my-rds-params","required":true},{"id":"family","label":"DB Parameter Group Family","type":"select","options":["mysql8.0","mysql5.7","postgres16","postgres15","aurora-mysql8.0","aurora-postgresql16","mariadb10.11"],"default":"mysql8.0"},{"id":"description","label":"Description","type":"text","default":"Managed by Terraform"}]',
  'resource "aws_db_parameter_group" "{{name}}" {
  name        = "{{group_name}}"
  family      = "{{family}}"
  description = "{{description}}"

  parameter {
    name  = "slow_query_log"
    value = "1"
  }

  parameter {
    name  = "long_query_time"
    value = "2"
  }

  tags = {
    Name      = "{{group_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'dynamodb_global_table', 'DynamoDB Global Table', 'Database', 'DDGLT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_global_table","required":true},{"id":"table_name","label":"Table Name","type":"text","default":"my-global-table","required":true},{"id":"hash_key","label":"Hash Key","type":"text","default":"id","required":true},{"id":"replica_regions","label":"Replica Regions (comma-sep)","type":"text","default":"us-west-2, eu-west-1","required":true}]',
  'resource "aws_dynamodb_table" "{{name}}" {
  name             = "{{table_name}}"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "{{hash_key}}"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "{{hash_key}}"
    type = "S"
  }

  dynamic "replica" {
    for_each = toset(split(",", trimspace("{{replica_regions}}")))
    content {
      region_name = trimspace(replica.value)
    }
  }

  server_side_encryption { enabled = true }
  point_in_time_recovery { enabled = true }

  tags = {
    Name      = "{{table_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'dax_cluster', 'DynamoDB DAX Cluster', 'Database', 'DAX',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_dax","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-dax-cluster","required":true},{"id":"node_type","label":"Node Type","type":"select","options":["dax.r4.large","dax.r4.xlarge","dax.r5.large","dax.r5.xlarge","dax.t3.small","dax.t3.medium"],"default":"dax.t3.small"},{"id":"replication_factor","label":"Replication Factor","type":"number","default":"1"},{"id":"iam_role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.dax.arn","required":true},{"id":"subnet_group_name","label":"Subnet Group Name / Ref","type":"text","default":"aws_dax_subnet_group.main.name"}]',
  'resource "aws_dax_cluster" "{{name}}" {
  cluster_name       = "{{cluster_name}}"
  iam_role_arn       = {{iam_role_arn}}
  node_type          = "{{node_type}}"
  replication_factor = {{replication_factor}}
  subnet_group_name  = {{subnet_group_name}}

  server_side_encryption { enabled = true }

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
  'neptune_cluster', 'Amazon Neptune Cluster', 'Database', 'NEPT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_neptune","required":true},{"id":"cluster_identifier","label":"Cluster Identifier","type":"text","default":"my-neptune-cluster","required":true},{"id":"instance_class","label":"Instance Class","type":"select","options":["db.t3.medium","db.r5.large","db.r5.xlarge","db.r6g.large","db.r6g.xlarge"],"default":"db.t3.medium"},{"id":"backup_retention","label":"Backup Retention (days)","type":"number","default":"7"},{"id":"skip_final_snapshot","label":"Skip Final Snapshot","type":"select","options":["true","false"],"default":"true"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_neptune_subnet_group" "{{name}}" {
  name       = "{{cluster_identifier}}-subnets"
  subnet_ids = [{{subnet_ids}}]
  tags = { ManagedBy = "Terraform" }
}

resource "aws_neptune_cluster" "{{name}}" {
  cluster_identifier                   = "{{cluster_identifier}}"
  engine                               = "neptune"
  backup_retention_period              = {{backup_retention}}
  skip_final_snapshot                  = {{skip_final_snapshot}}
  iam_database_authentication_enabled  = true
  storage_encrypted                    = true
  neptune_subnet_group_name            = aws_neptune_subnet_group.{{name}}.name

  tags = {
    Name      = "{{cluster_identifier}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_neptune_cluster_instance" "{{name}}" {
  count              = 1
  cluster_identifier = aws_neptune_cluster.{{name}}.id
  engine             = "neptune"
  instance_class     = "{{instance_class}}"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'memorydb_cluster', 'MemoryDB for Redis', 'Database', 'MMDB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_memorydb","required":true},{"id":"cluster_name","label":"Cluster Name","type":"text","default":"my-memorydb","required":true},{"id":"node_type","label":"Node Type","type":"select","options":["db.t4g.small","db.t4g.medium","db.r6g.large","db.r6g.xlarge","db.r6g.2xlarge"],"default":"db.t4g.small"},{"id":"num_shards","label":"Number of Shards","type":"number","default":"1"},{"id":"replicas_per_shard","label":"Replicas Per Shard","type":"number","default":"1"},{"id":"engine_version","label":"Redis Engine Version","type":"select","options":["7.1","7.0","6.2"],"default":"7.1"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_memorydb_subnet_group" "{{name}}" {
  name       = "{{cluster_name}}-subnets"
  subnet_ids = [{{subnet_ids}}]
  tags = { ManagedBy = "Terraform" }
}

resource "aws_memorydb_cluster" "{{name}}" {
  name                   = "{{cluster_name}}"
  node_type              = "{{node_type}}"
  num_shards             = {{num_shards}}
  num_replicas_per_shard = {{replicas_per_shard}}
  engine_version         = "{{engine_version}}"
  subnet_group_name      = aws_memorydb_subnet_group.{{name}}.id
  tls_enabled            = true

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
  'keyspaces_table', 'Amazon Keyspaces (Cassandra) Table', 'Database', 'KSPC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_keyspaces_table","required":true},{"id":"keyspace_name","label":"Keyspace Name","type":"text","default":"my_keyspace","required":true},{"id":"table_name","label":"Table Name","type":"text","default":"my_table","required":true},{"id":"partition_key","label":"Partition Key Column","type":"text","default":"id"},{"id":"billing_mode","label":"Billing Mode","type":"select","options":["PAY_PER_REQUEST","PROVISIONED"],"default":"PAY_PER_REQUEST"}]',
  'resource "aws_keyspaces_keyspace" "{{name}}" {
  name = "{{keyspace_name}}"
  tags = { ManagedBy = "Terraform" }
}

resource "aws_keyspaces_table" "{{name}}" {
  keyspace_name = aws_keyspaces_keyspace.{{name}}.name
  table_name    = "{{table_name}}"

  schema_definition {
    column {
      name = "{{partition_key}}"
      type = "text"
    }
    column {
      name = "created_at"
      type = "timestamp"
    }
    partition_key {
      name = "{{partition_key}}"
    }
  }

  capacity_specification {
    throughput_mode = "{{billing_mode}}"
  }

  encryption_specification {
    type = "AWS_OWNED_KMS_KEY"
  }

  point_in_time_recovery { status = "ENABLED" }

  tags = {
    Name      = "{{table_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- IAM & SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'iam_access_analyzer', 'IAM Access Analyzer', 'IAM & Security', 'AA',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_access_analyzer","required":true},{"id":"analyzer_name","label":"Analyzer Name","type":"text","default":"my-access-analyzer","required":true},{"id":"type","label":"Analyzer Type","type":"select","options":["ACCOUNT","ORGANIZATION","ACCOUNT_UNUSED_ACCESS","ORGANIZATION_UNUSED_ACCESS"],"default":"ACCOUNT"}]',
  'resource "aws_accessanalyzer_analyzer" "{{name}}" {
  analyzer_name = "{{analyzer_name}}"
  type          = "{{type}}"

  tags = {
    Name      = "{{analyzer_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'shield_protection', 'AWS Shield Advanced', 'IAM & Security', 'SHLD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_shield","required":true},{"id":"protection_name","label":"Protection Name","type":"text","default":"my-shield-protection","required":true},{"id":"resource_arn","label":"Resource ARN to Protect (ALB/EIP/CloudFront)","type":"text","default":"aws_lb.my_alb.arn","required":true}]',
  'resource "aws_shield_protection" "{{name}}" {
  name         = "{{protection_name}}"
  resource_arn = {{resource_arn}}

  tags = {
    Name      = "{{protection_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'fms_policy', 'Firewall Manager Policy', 'IAM & Security', 'FMS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_fms_policy","required":true},{"id":"policy_name","label":"Policy Name","type":"text","default":"centralized-waf-policy","required":true},{"id":"remediation","label":"Auto Remediation","type":"select","options":["true","false"],"default":"false"},{"id":"exclude_not_in_scope","label":"Exclude Resources Not In Scope","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_fms_policy" "{{name}}" {
  name                           = "{{policy_name}}"
  exclude_not_in_scope_resources = {{exclude_not_in_scope}}
  remediation_enabled            = {{remediation}}
  resource_type                  = "AWS::ElasticLoadBalancingV2::LoadBalancer"

  security_service_policy_data {
    type = "WAFV2"
    managed_service_data = jsonencode({
      type                                    = "WAFV2"
      defaultAction                           = { type = "ALLOW" }
      overrideCustomerWebACLAssociation       = false
      sampledRequestsEnabledForDefaultActions = true
      preProcessRuleGroups                    = []
      postProcessRuleGroups                   = []
    })
  }

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
  'ssoadmin_instance', 'IAM Identity Center (SSO)', 'IAM & Security', 'SSO',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sso","required":true},{"id":"permission_set_name","label":"Permission Set Name","type":"text","default":"DevOpsAccess","required":true},{"id":"managed_policy_arn","label":"Managed Policy ARN","type":"text","default":"arn:aws:iam::aws:policy/ReadOnlyAccess"},{"id":"session_duration","label":"Session Duration","type":"select","options":["PT1H","PT4H","PT8H","PT12H","PT24H"],"default":"PT8H"}]',
  'data "aws_ssoadmin_instances" "{{name}}" {}

resource "aws_ssoadmin_permission_set" "{{name}}" {
  name             = "{{permission_set_name}}"
  instance_arn     = tolist(data.aws_ssoadmin_instances.{{name}}.arns)[0]
  session_duration = "{{session_duration}}"

  tags = {
    Name      = "{{permission_set_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_ssoadmin_managed_policy_attachment" "{{name}}" {
  instance_arn       = tolist(data.aws_ssoadmin_instances.{{name}}.arns)[0]
  managed_policy_arn = "{{managed_policy_arn}}"
  permission_set_arn = aws_ssoadmin_permission_set.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ram_resource_share', 'Resource Access Manager Share', 'IAM & Security', 'RAM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ram_share","required":true},{"id":"share_name","label":"Share Name","type":"text","default":"my-resource-share","required":true},{"id":"allow_external_principals","label":"Allow External Principals","type":"select","options":["true","false"],"default":"false"},{"id":"resource_arn","label":"Resource ARN / Ref to Share","type":"text","default":"aws_subnet.private_a.arn"},{"id":"principal","label":"Principal (account ID or OU ARN)","type":"text","default":"123456789012"}]',
  'resource "aws_ram_resource_share" "{{name}}" {
  name                      = "{{share_name}}"
  allow_external_principals = {{allow_external_principals}}

  tags = {
    Name      = "{{share_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_ram_resource_association" "{{name}}" {
  resource_arn       = {{resource_arn}}
  resource_share_arn = aws_ram_resource_share.{{name}}.arn
}

resource "aws_ram_principal_association" "{{name}}" {
  principal          = "{{principal}}"
  resource_share_arn = aws_ram_resource_share.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'directory_service_directory', 'AWS Directory Service (AD)', 'IAM & Security', 'AD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_directory","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"corp.example.com","required":true},{"id":"short_name","label":"Short Name (NetBIOS)","type":"text","default":"CORP"},{"id":"password","label":"Admin Password (use var)","type":"text","default":"var.ad_password"},{"id":"type","label":"Directory Type","type":"select","options":["SimpleAD","MicrosoftAD"],"default":"MicrosoftAD"},{"id":"edition","label":"Edition (MicrosoftAD only)","type":"select","options":["Standard","Enterprise"],"default":"Standard"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep, 2 required)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_directory_service_directory" "{{name}}" {
  name       = "{{domain_name}}"
  short_name = "{{short_name}}"
  password   = {{password}}
  type       = "{{type}}"
  edition    = "{{edition}}"

  vpc_settings {
    vpc_id     = aws_vpc.main.id
    subnet_ids = [{{subnet_ids}}]
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
  'cognito_identity_pool', 'Cognito Identity Pool', 'IAM & Security', 'CIDP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_identity_pool","required":true},{"id":"pool_name","label":"Identity Pool Name","type":"text","default":"my_identity_pool","required":true},{"id":"allow_unauthenticated","label":"Allow Unauthenticated Identities","type":"select","options":["false","true"],"default":"false"},{"id":"user_pool_id","label":"Cognito User Pool ID / Ref","type":"text","default":"aws_cognito_user_pool.main.id"},{"id":"user_pool_client_id","label":"User Pool Client ID / Ref","type":"text","default":"aws_cognito_user_pool_client.app.id"},{"id":"authenticated_role_arn","label":"Authenticated IAM Role ARN / Ref","type":"text","default":"aws_iam_role.authenticated.arn"},{"id":"unauthenticated_role_arn","label":"Unauthenticated IAM Role ARN / Ref","type":"text","default":"aws_iam_role.unauthenticated.arn"}]',
  'resource "aws_cognito_identity_pool" "{{name}}" {
  identity_pool_name               = "{{pool_name}}"
  allow_unauthenticated_identities = {{allow_unauthenticated}}

  cognito_identity_providers {
    client_id     = {{user_pool_client_id}}
    provider_name = "cognito-idp.${data.aws_region.current.name}.amazonaws.com/${{{user_pool_id}}}"
    server_side_token_check = false
  }

  tags = {
    Name      = "{{pool_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_cognito_identity_pool_roles_attachment" "{{name}}" {
  identity_pool_id = aws_cognito_identity_pool.{{name}}.id

  roles = {
    authenticated   = {{authenticated_role_arn}}
    unauthenticated = {{unauthenticated_role_arn}}
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'acmpca_certificate_authority', 'ACM Private Certificate Authority', 'IAM & Security', 'PCA',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_private_ca","required":true},{"id":"common_name","label":"Common Name","type":"text","default":"Internal CA","required":true},{"id":"organization","label":"Organization","type":"text","default":"My Company"},{"id":"country","label":"Country Code","type":"text","default":"US"},{"id":"ca_type","label":"CA Type","type":"select","options":["ROOT","SUBORDINATE"],"default":"ROOT"},{"id":"key_algorithm","label":"Key Algorithm","type":"select","options":["RSA_2048","RSA_4096","EC_prime256v1","EC_secp384r1"],"default":"RSA_2048"},{"id":"signing_algorithm","label":"Signing Algorithm","type":"select","options":["SHA256WITHRSA","SHA384WITHRSA","SHA256WITHECDSA"],"default":"SHA256WITHRSA"}]',
  'resource "aws_acmpca_certificate_authority" "{{name}}" {
  type                            = "{{ca_type}}"
  permanent_deletion_time_in_days = 7

  certificate_authority_configuration {
    key_algorithm     = "{{key_algorithm}}"
    signing_algorithm = "{{signing_algorithm}}"

    subject {
      common_name  = "{{common_name}}"
      organization = "{{organization}}"
      country      = "{{country}}"
    }
  }

  revocation_configuration {
    crl_configuration {
      enabled = false
    }
  }

  tags = {
    Name      = "{{common_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'verifiedaccess_instance', 'AWS Verified Access', 'IAM & Security', 'VA',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_verified_access","required":true},{"id":"description","label":"Description","type":"text","default":"Zero-trust access without VPN"},{"id":"fips_enabled","label":"FIPS Enabled","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_verifiedaccess_instance" "{{name}}" {
  description  = "{{description}}"
  fips_enabled = {{fips_enabled}}

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_verifiedaccess_trust_provider" "{{name}}" {
  trust_provider_type      = "user"
  user_trust_provider_type = "iam-identity-center"
  description              = "IAM Identity Center trust provider"
  policy_reference_name    = "idc"

  tags = { ManagedBy = "Terraform" }
}

resource "aws_verifiedaccess_instance_trust_provider_attachment" "{{name}}" {
  verifiedaccess_instance_id       = aws_verifiedaccess_instance.{{name}}.id
  verifiedaccess_trust_provider_id = aws_verifiedaccess_trust_provider.{{name}}.id
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- CI/CD & DEVELOPER TOOLS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codestarconnections_connection', 'CodeStar Connection (GitHub/GitLab)', 'CI/CD', 'CSTAR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_github_connection","required":true},{"id":"connection_name","label":"Connection Name","type":"text","default":"github-connection","required":true},{"id":"provider_type","label":"Provider Type","type":"select","options":["GitHub","GitHubEnterpriseServer","GitLab","GitLabSelfManaged","Bitbucket"],"default":"GitHub"}]',
  'resource "aws_codestarconnections_connection" "{{name}}" {
  name          = "{{connection_name}}"
  provider_type = "{{provider_type}}"

  tags = {
    Name      = "{{connection_name}}"
    ManagedBy = "Terraform"
  }
}

output "{{name}}_arn" {
  value = aws_codestarconnections_connection.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ecrpublic_repository', 'ECR Public Repository', 'Containers', 'ECRPUB',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_public_ecr","required":true},{"id":"repository_name","label":"Repository Name","type":"text","default":"my-public-images","required":true},{"id":"about_text","label":"About Text","type":"text","default":"Public container images"},{"id":"usage_text","label":"Usage Text","type":"text","default":"docker pull public.ecr.aws/myalias/my-public-images"}]',
  '# Note: ECR Public requires us-east-1 region
resource "aws_ecrpublic_repository" "{{name}}" {
  provider        = aws.us_east_1
  repository_name = "{{repository_name}}"

  catalog_data {
    about_text = "{{about_text}}"
    usage_text = "{{usage_text}}"
  }

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
  'api_gateway_domain_name', 'API Gateway Custom Domain', 'CI/CD', 'APIGWD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_api_domain","required":true},{"id":"domain_name","label":"Custom Domain Name","type":"text","default":"api.example.com","required":true},{"id":"certificate_arn","label":"ACM Certificate ARN / Ref","type":"text","default":"aws_acm_certificate.api.arn","required":true},{"id":"endpoint_type","label":"Endpoint Type","type":"select","options":["REGIONAL","EDGE"],"default":"REGIONAL"},{"id":"security_policy","label":"TLS Security Policy","type":"select","options":["TLS_1_2","TLS_1_0"],"default":"TLS_1_2"}]',
  'resource "aws_api_gateway_domain_name" "{{name}}" {
  domain_name              = "{{domain_name}}"
  regional_certificate_arn = {{certificate_arn}}
  security_policy          = "{{security_policy}}"

  endpoint_configuration {
    types = ["{{endpoint_type}}"]
  }

  tags = {
    Name      = "{{domain_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_route53_record" "{{name}}" {
  name    = aws_api_gateway_domain_name.{{name}}.domain_name
  type    = "A"
  zone_id = aws_route53_zone.main.zone_id

  alias {
    evaluate_target_health = true
    name                   = aws_api_gateway_domain_name.{{name}}.regional_domain_name
    zone_id                = aws_api_gateway_domain_name.{{name}}.regional_zone_id
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'api_gateway_stage', 'API Gateway Stage', 'CI/CD', 'APIGS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_api_stage","required":true},{"id":"rest_api_id","label":"REST API ID / Ref","type":"text","default":"aws_api_gateway_rest_api.main.id","required":true},{"id":"deployment_id","label":"Deployment ID / Ref","type":"text","default":"aws_api_gateway_deployment.main.id","required":true},{"id":"stage_name","label":"Stage Name","type":"text","default":"prod","required":true},{"id":"throttling_burst","label":"Throttling Burst Limit","type":"number","default":"5000"},{"id":"throttling_rate","label":"Throttling Rate Limit","type":"number","default":"10000"},{"id":"xray_tracing","label":"X-Ray Tracing","type":"select","options":["true","false"],"default":"true"},{"id":"logging_level","label":"Logging Level","type":"select","options":["OFF","ERROR","INFO"],"default":"ERROR"}]',
  'resource "aws_api_gateway_stage" "{{name}}" {
  rest_api_id          = {{rest_api_id}}
  deployment_id        = {{deployment_id}}
  stage_name           = "{{stage_name}}"
  xray_tracing_enabled = {{xray_tracing}}

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn
  }

  tags = {
    Name      = "{{stage_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_api_gateway_method_settings" "{{name}}" {
  rest_api_id = {{rest_api_id}}
  stage_name  = aws_api_gateway_stage.{{name}}.stage_name
  method_path = "*/*"

  settings {
    throttling_burst_limit = {{throttling_burst}}
    throttling_rate_limit  = {{throttling_rate}}
    logging_level          = "{{logging_level}}"
    metrics_enabled        = true
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'appconfig_application', 'AWS AppConfig', 'CI/CD', 'APPCFG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_appconfig","required":true},{"id":"app_name","label":"Application Name","type":"text","default":"my-app","required":true},{"id":"description","label":"Description","type":"text","default":"Feature flags and config"},{"id":"environment_name","label":"Environment Name","type":"text","default":"production"}]',
  'resource "aws_appconfig_application" "{{name}}" {
  name        = "{{app_name}}"
  description = "{{description}}"

  tags = {
    Name      = "{{app_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_appconfig_environment" "{{name}}" {
  application_id = aws_appconfig_application.{{name}}.id
  name           = "{{environment_name}}"
  description    = "{{environment_name}} environment"

  tags = { ManagedBy = "Terraform" }
}

resource "aws_appconfig_configuration_profile" "{{name}}" {
  application_id = aws_appconfig_application.{{name}}.id
  name           = "{{app_name}}-config"
  location_uri   = "hosted"

  tags = { ManagedBy = "Terraform" }
}

resource "aws_appconfig_hosted_configuration_version" "{{name}}" {
  application_id           = aws_appconfig_application.{{name}}.id
  configuration_profile_id = aws_appconfig_configuration_profile.{{name}}.configuration_profile_id
  content_type             = "application/json"
  content = jsonencode({
    featureFlags = {
      newDashboard = false
      betaFeature  = false
    }
  })
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloud9_environment_ec2', 'Cloud9 IDE Environment', 'CI/CD', 'C9',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cloud9","required":true},{"id":"env_name","label":"Environment Name","type":"text","default":"my-dev-env","required":true},{"id":"instance_type","label":"Instance Type","type":"select","options":["t2.micro","t3.small","t3.medium","m5.large"],"default":"t3.small"},{"id":"automatic_stop_minutes","label":"Auto-Stop After (minutes)","type":"number","default":"30"}]',
  'resource "aws_cloud9_environment_ec2" "{{name}}" {
  name                        = "{{env_name}}"
  instance_type               = "{{instance_type}}"
  automatic_stop_time_minutes = {{automatic_stop_minutes}}

  tags = {
    Name      = "{{env_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'codegurureviewer_repository_association', 'CodeGuru Reviewer', 'CI/CD', 'CGR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_codeguru","required":true},{"id":"connection_arn","label":"CodeStar Connection ARN / Ref","type":"text","default":"aws_codestarconnections_connection.github.arn","required":true},{"id":"repository_name","label":"Repository Name","type":"text","default":"my-repo","required":true},{"id":"owner","label":"Repository Owner","type":"text","default":"my-github-org","required":true}]',
  'resource "aws_codegurureviewer_repository_association" "{{name}}" {
  repository {
    bitbucket {
      connection_arn = {{connection_arn}}
      name           = "{{repository_name}}"
      owner          = "{{owner}}"
    }
  }

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
  'servicecatalog_portfolio', 'Service Catalog Portfolio', 'CI/CD', 'SVCCAT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_portfolio","required":true},{"id":"portfolio_name","label":"Portfolio Name","type":"text","default":"Platform Engineering Catalog","required":true},{"id":"description","label":"Description","type":"text","default":"Self-service infrastructure templates"},{"id":"provider_name","label":"Provider Name","type":"text","default":"Platform Team"}]',
  'resource "aws_servicecatalog_portfolio" "{{name}}" {
  name          = "{{portfolio_name}}"
  description   = "{{description}}"
  provider_name = "{{provider_name}}"

  tags = {
    Name      = "{{portfolio_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- MONITORING & OBSERVABILITY
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_composite_alarm', 'CloudWatch Composite Alarm', 'Monitoring', 'CWALM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_composite_alarm","required":true},{"id":"alarm_name","label":"Alarm Name","type":"text","default":"composite-health-alarm","required":true},{"id":"alarm_description","label":"Description","type":"text","default":"Composite alarm combining multiple metrics"},{"id":"alarm_rule","label":"Alarm Rule Expression","type":"text","default":"ALARM(\"cpu-alarm\") OR ALARM(\"memory-alarm\")","required":true},{"id":"alarm_actions","label":"SNS Topic ARN / Ref","type":"text","default":"aws_sns_topic.alerts.arn"}]',
  'resource "aws_cloudwatch_composite_alarm" "{{name}}" {
  alarm_name        = "{{alarm_name}}"
  alarm_description = "{{alarm_description}}"
  alarm_rule        = "{{alarm_rule}}"
  actions_enabled   = true
  alarm_actions     = [{{alarm_actions}}]

  tags = {
    Name      = "{{alarm_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'synthetics_canary', 'CloudWatch Synthetics Canary', 'Monitoring', 'CWNRY',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_canary","required":true},{"id":"canary_name","label":"Canary Name","type":"text","default":"my-endpoint-canary","required":true},{"id":"runtime_version","label":"Runtime Version","type":"select","options":["syn-nodejs-puppeteer-9.1","syn-python-selenium-4.0","syn-nodejs-puppeteer-7.0"],"default":"syn-nodejs-puppeteer-9.1"},{"id":"schedule_expression","label":"Schedule Expression","type":"text","default":"rate(5 minutes)"},{"id":"s3_bucket","label":"S3 Artifact Bucket Name","type":"text","default":"my-canary-artifacts"},{"id":"handler","label":"Handler","type":"text","default":"canary.handler"},{"id":"execution_role_arn","label":"Execution Role ARN / Ref","type":"text","default":"aws_iam_role.canary.arn"}]',
  'resource "aws_synthetics_canary" "{{name}}" {
  name                 = "{{canary_name}}"
  artifact_s3_location = "s3://{{s3_bucket}}/canary/"
  execution_role_arn   = {{execution_role_arn}}
  runtime_version      = "{{runtime_version}}"
  handler              = "{{handler}}"
  start_canary         = true

  schedule {
    expression = "{{schedule_expression}}"
  }

  run_config {
    timeout_in_seconds = 60
    memory_in_mb       = 960
    active_tracing     = true
  }

  success_retention_period = 2
  failure_retention_period = 14

  tags = {
    Name      = "{{canary_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_metric_stream', 'CloudWatch Metric Stream', 'Monitoring', 'CWMS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_metric_stream","required":true},{"id":"stream_name","label":"Stream Name","type":"text","default":"my-metrics-stream","required":true},{"id":"firehose_arn","label":"Kinesis Firehose ARN / Ref","type":"text","default":"aws_kinesis_firehose_delivery_stream.metrics.arn","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.metric_stream.arn","required":true},{"id":"output_format","label":"Output Format","type":"select","options":["json","opentelemetry0.7","opentelemetry1.0"],"default":"json"}]',
  'resource "aws_cloudwatch_metric_stream" "{{name}}" {
  name          = "{{stream_name}}"
  role_arn      = {{role_arn}}
  firehose_arn  = {{firehose_arn}}
  output_format = "{{output_format}}"

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
  'rum_app_monitor', 'CloudWatch RUM (Real User Monitoring)', 'Monitoring', 'RUM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_rum","required":true},{"id":"monitor_name","label":"Monitor Name","type":"text","default":"my-web-app","required":true},{"id":"domain","label":"Application Domain","type":"text","default":"app.example.com","required":true},{"id":"session_sample_rate","label":"Session Sample Rate (0-1)","type":"text","default":"0.1"},{"id":"identity_pool_id","label":"Cognito Identity Pool ID / Ref","type":"text","default":"aws_cognito_identity_pool.rum.id"},{"id":"retention_days","label":"Data Retention (days)","type":"number","default":"30"}]',
  'resource "aws_rum_app_monitor" "{{name}}" {
  name            = "{{monitor_name}}"
  domain          = "{{domain}}"
  cw_log_enabled  = true

  app_monitor_configuration {
    allow_cookies       = true
    enable_xray         = true
    session_sample_rate = {{session_sample_rate}}
    telemetries         = ["errors", "performance", "http"]
    identity_pool_id    = {{identity_pool_id}}
  }

  tags = {
    Name      = "{{monitor_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'pipes_pipe', 'EventBridge Pipes', 'Monitoring', 'PIPE',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_pipe","required":true},{"id":"pipe_name","label":"Pipe Name","type":"text","default":"my-event-pipe","required":true},{"id":"source_arn","label":"Source ARN / Ref (SQS/DynamoDB/Kinesis)","type":"text","default":"aws_sqs_queue.source.arn","required":true},{"id":"target_arn","label":"Target ARN / Ref (Lambda/SFN etc.)","type":"text","default":"aws_lambda_function.processor.arn","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.pipes.arn","required":true},{"id":"batch_size","label":"Batch Size","type":"number","default":"10"}]',
  'resource "aws_pipes_pipe" "{{name}}" {
  name     = "{{pipe_name}}"
  source   = {{source_arn}}
  target   = {{target_arn}}
  role_arn = {{role_arn}}

  source_parameters {
    sqs_queue_parameters {
      batch_size = {{batch_size}}
    }
  }

  tags = {
    Name      = "{{pipe_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'scheduler_schedule', 'EventBridge Scheduler', 'Monitoring', 'SCHED',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_schedule","required":true},{"id":"schedule_name","label":"Schedule Name","type":"text","default":"my-cron-job","required":true},{"id":"group_name","label":"Schedule Group","type":"text","default":"default"},{"id":"schedule_expression","label":"Schedule Expression","type":"text","default":"cron(0 6 * * ? *)"},{"id":"timezone","label":"Timezone","type":"text","default":"UTC"},{"id":"target_arn","label":"Target ARN / Ref","type":"text","default":"aws_lambda_function.my_fn.arn","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.scheduler.arn","required":true}]',
  'resource "aws_scheduler_schedule" "{{name}}" {
  name       = "{{schedule_name}}"
  group_name = "{{group_name}}"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "{{schedule_expression}}"
  schedule_expression_timezone = "{{timezone}}"

  target {
    arn      = {{target_arn}}
    role_arn = {{role_arn}}
  }

  tags = {
    Name      = "{{schedule_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'devopsguru_resource_collection', 'DevOps Guru', 'Monitoring', 'DOG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_devopsguru","required":true},{"id":"type","label":"Collection Type","type":"select","options":["AWS_CLOUD_FORMATION","AWS_SERVICE","TAGS"],"default":"AWS_CLOUD_FORMATION"},{"id":"stack_names","label":"CloudFormation Stack Names (comma-sep)","type":"text","default":"my-app-stack"}]',
  'resource "aws_devopsguru_resource_collection" "{{name}}" {
  type = "{{type}}"

  cloudformation {
    stack_names = split(",", trimspace("{{stack_names}}"))
  }
}

resource "aws_devopsguru_notification_channel" "{{name}}" {
  config {
    sns {
      topic_arn = aws_sns_topic.devopsguru_alerts.arn
    }
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'chatbot_slack_channel_configuration', 'AWS Chatbot (Slack/Teams)', 'Monitoring', 'CHAT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_chatbot","required":true},{"id":"config_name","label":"Configuration Name","type":"text","default":"ops-slack-alerts","required":true},{"id":"slack_workspace_id","label":"Slack Workspace ID","type":"text","default":"T00000000","required":true},{"id":"slack_channel_id","label":"Slack Channel ID","type":"text","default":"C00000000","required":true},{"id":"sns_topic_arns","label":"SNS Topic ARNs (comma-sep)","type":"text","default":"aws_sns_topic.alerts.arn"},{"id":"iam_role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.chatbot.arn","required":true},{"id":"logging_level","label":"Logging Level","type":"select","options":["ERROR","INFO","NONE"],"default":"ERROR"}]',
  'resource "aws_chatbot_slack_channel_configuration" "{{name}}" {
  configuration_name = "{{config_name}}"
  iam_role_arn       = {{iam_role_arn}}
  slack_workspace_id = "{{slack_workspace_id}}"
  slack_channel_id   = "{{slack_channel_id}}"
  sns_topic_arns     = [{{sns_topic_arns}}]
  logging_level      = "{{logging_level}}"

  tags = {
    Name      = "{{config_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'glue_crawler', 'AWS Glue Crawler', 'Analytics', 'GCRL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_glue_crawler","required":true},{"id":"crawler_name","label":"Crawler Name","type":"text","default":"my-data-crawler","required":true},{"id":"database_name","label":"Glue Database Name / Ref","type":"text","default":"aws_glue_catalog_database.main.name","required":true},{"id":"s3_path","label":"S3 Data Path","type":"text","default":"s3://my-data-lake/raw/","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.glue_crawler.arn","required":true},{"id":"schedule","label":"Schedule (cron expression)","type":"text","default":"cron(0 12 * * ? *)"}]',
  'resource "aws_glue_crawler" "{{name}}" {
  name          = "{{crawler_name}}"
  database_name = {{database_name}}
  role          = {{role_arn}}
  schedule      = "{{schedule}}"

  s3_target {
    path = "{{s3_path}}"
  }

  schema_change_policy {
    update_behavior = "UPDATE_IN_DATABASE"
    delete_behavior = "DEPRECATE_IN_DATABASE"
  }

  tags = {
    Name      = "{{crawler_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'glue_workflow', 'AWS Glue Workflow', 'Analytics', 'GWF',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_glue_workflow","required":true},{"id":"workflow_name","label":"Workflow Name","type":"text","default":"my-etl-workflow","required":true},{"id":"description","label":"Description","type":"text","default":"ETL pipeline orchestration"},{"id":"max_concurrent_runs","label":"Max Concurrent Runs","type":"number","default":"1"}]',
  'resource "aws_glue_workflow" "{{name}}" {
  name                = "{{workflow_name}}"
  description         = "{{description}}"
  max_concurrent_runs = {{max_concurrent_runs}}

  tags = {
    Name      = "{{workflow_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_glue_trigger" "{{name}}_start" {
  name          = "{{workflow_name}}-trigger"
  type          = "ON_DEMAND"
  workflow_name = aws_glue_workflow.{{name}}.name

  actions {
    job_name = "my-glue-job"
  }

  tags = { ManagedBy = "Terraform" }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'lakeformation_resource', 'AWS Lake Formation', 'Analytics', 'LFM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_lakeformation","required":true},{"id":"bucket_arn","label":"S3 Bucket ARN / Ref to Register","type":"text","default":"aws_s3_bucket.data_lake.arn","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref (Data Lake Admin)","type":"text","default":"aws_iam_role.lakeformation_admin.arn"},{"id":"admin_principal_arn","label":"Admin Principal ARN","type":"text","default":"arn:aws:iam::123456789012:role/DataEngineer"}]',
  'resource "aws_lakeformation_resource" "{{name}}" {
  arn      = {{bucket_arn}}
  role_arn = {{role_arn}}
}

resource "aws_lakeformation_data_lake_settings" "{{name}}" {
  admins = ["{{admin_principal_arn}}"]
}

resource "aws_lakeformation_permissions" "{{name}}" {
  principal   = "{{admin_principal_arn}}"
  permissions = ["ALL"]

  database {
    name = aws_glue_catalog_database.main.name
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'quicksight_data_set', 'QuickSight Dataset', 'Analytics', 'QS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_quicksight_dataset","required":true},{"id":"dataset_id","label":"Dataset ID","type":"text","default":"my-dataset","required":true},{"id":"dataset_name","label":"Dataset Name","type":"text","default":"My Dataset","required":true},{"id":"import_mode","label":"Import Mode","type":"select","options":["SPICE","DIRECT_QUERY"],"default":"SPICE"},{"id":"datasource_arn","label":"Data Source ARN / Ref","type":"text","default":"aws_quicksight_data_source.main.arn"}]',
  'data "aws_caller_identity" "current" {}

resource "aws_quicksight_data_set" "{{name}}" {
  data_set_id    = "{{dataset_id}}"
  name           = "{{dataset_name}}"
  aws_account_id = data.aws_caller_identity.current.account_id
  import_mode    = "{{import_mode}}"

  physical_table_map {
    physical_table_map_id = "main"

    relational_table {
      data_source_arn = {{datasource_arn}}
      schema          = "public"
      name            = "my_table"

      input_columns {
        name = "id"
        type = "STRING"
      }
    }
  }

  tags = {
    Name      = "{{dataset_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'opensearchserverless_collection', 'OpenSearch Serverless Collection', 'Analytics', 'OSSVR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_oss_collection","required":true},{"id":"collection_name","label":"Collection Name","type":"text","default":"my-search","required":true},{"id":"collection_type","label":"Collection Type","type":"select","options":["SEARCH","TIMESERIES","VECTORSEARCH"],"default":"SEARCH"},{"id":"description","label":"Description","type":"text","default":"Serverless OpenSearch collection"}]',
  'resource "aws_opensearchserverless_security_policy" "{{name}}_enc" {
  name  = "{{collection_name}}-enc"
  type  = "encryption"
  policy = jsonencode({
    Rules       = [{ Resource = ["collection/{{collection_name}}"], ResourceType = "collection" }]
    AWSOwnedKey = true
  })
}

resource "aws_opensearchserverless_security_policy" "{{name}}_net" {
  name  = "{{collection_name}}-net"
  type  = "network"
  policy = jsonencode([{
    Rules = [
      { ResourceType = "collection", Resource = ["collection/{{collection_name}}"] },
      { ResourceType = "dashboard",  Resource = ["collection/{{collection_name}}"] }
    ]
    AllowFromPublic = true
  }])
}

resource "aws_opensearchserverless_collection" "{{name}}" {
  name        = "{{collection_name}}"
  type        = "{{collection_type}}"
  description = "{{description}}"

  depends_on = [
    aws_opensearchserverless_security_policy.{{name}}_enc,
    aws_opensearchserverless_security_policy.{{name}}_net,
  ]

  tags = {
    Name      = "{{collection_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'redshift_serverless_workgroup', 'Redshift Serverless Workgroup', 'Analytics', 'RSVR',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_redshift_serverless","required":true},{"id":"workgroup_name","label":"Workgroup Name","type":"text","default":"my-workgroup","required":true},{"id":"namespace_name","label":"Namespace Name","type":"text","default":"my-namespace","required":true},{"id":"base_capacity","label":"Base Capacity (RPU)","type":"select","options":["8","16","32","64","128","256","512"],"default":"8"},{"id":"db_name","label":"Database Name","type":"text","default":"dev"},{"id":"admin_username","label":"Admin Username","type":"text","default":"admin"},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id, aws_subnet.private_b.id"}]',
  'resource "aws_redshiftserverless_namespace" "{{name}}" {
  namespace_name      = "{{namespace_name}}"
  db_name             = "{{db_name}}"
  admin_username      = "{{admin_username}}"
  admin_user_password = var.redshift_admin_password

  tags = {
    Name      = "{{namespace_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_redshiftserverless_workgroup" "{{name}}" {
  namespace_name = aws_redshiftserverless_namespace.{{name}}.namespace_name
  workgroup_name = "{{workgroup_name}}"
  base_capacity  = {{base_capacity}}
  subnet_ids     = [{{subnet_ids}}]

  tags = {
    Name      = "{{workgroup_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- APP INTEGRATION
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ses_configuration_set', 'SES Configuration Set', 'App Integration', 'SESCFG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ses_config","required":true},{"id":"config_name","label":"Configuration Set Name","type":"text","default":"my-email-config","required":true},{"id":"tls_policy","label":"TLS Policy","type":"select","options":["REQUIRE","OPTIONAL"],"default":"REQUIRE"},{"id":"sending_enabled","label":"Sending Enabled","type":"select","options":["true","false"],"default":"true"},{"id":"sns_topic_arn","label":"SNS Topic ARN for Events / Ref","type":"text","default":"aws_sns_topic.ses_events.arn"}]',
  'resource "aws_ses_configuration_set" "{{name}}" {
  name            = "{{config_name}}"
  sending_enabled = {{sending_enabled}}

  delivery_options {
    tls_policy = "{{tls_policy}}"
  }
}

resource "aws_ses_event_destination" "{{name}}" {
  name                   = "{{config_name}}-events"
  configuration_set_name = aws_ses_configuration_set.{{name}}.name
  enabled                = true
  matching_types         = ["bounce", "complaint", "delivery"]

  sns_destination {
    topic_arn = {{sns_topic_arn}}
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'pinpoint_app', 'Amazon Pinpoint App', 'App Integration', 'PNPT',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_pinpoint","required":true},{"id":"app_name","label":"App Name","type":"text","default":"my-pinpoint-app","required":true},{"id":"quiet_time_start","label":"Quiet Time Start (HH:MM)","type":"text","default":"22:00"},{"id":"quiet_time_end","label":"Quiet Time End (HH:MM)","type":"text","default":"06:00"},{"id":"limits_daily","label":"Daily Message Limit per Endpoint","type":"number","default":"10"},{"id":"limits_total","label":"Total Campaign Message Limit","type":"number","default":"100"}]',
  'resource "aws_pinpoint_app" "{{name}}" {
  name = "{{app_name}}"

  quiet_time {
    start = "{{quiet_time_start}}"
    end   = "{{quiet_time_end}}"
  }

  limits {
    daily               = {{limits_daily}}
    total               = {{limits_total}}
    messages_per_second = 20
  }

  tags = {
    Name      = "{{app_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'appflow_flow', 'AppFlow (SaaS Integration)', 'App Integration', 'AFLW',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_appflow","required":true},{"id":"flow_name","label":"Flow Name","type":"text","default":"salesforce-to-s3","required":true},{"id":"description","label":"Description","type":"text","default":"Sync Salesforce to S3"},{"id":"source_connector","label":"Source Connector Type","type":"select","options":["Salesforce","ServiceNow","Marketo","Slack","Zendesk","GoogleAnalytics4"],"default":"Salesforce"},{"id":"destination_bucket","label":"Destination S3 Bucket Name / Ref","type":"text","default":"aws_s3_bucket.data_lake.bucket","required":true},{"id":"schedule_rate_minutes","label":"Schedule Rate (minutes)","type":"number","default":"60"}]',
  'resource "aws_appflow_flow" "{{name}}" {
  name        = "{{flow_name}}"
  description = "{{description}}"

  source_flow_config {
    connector_type = "{{source_connector}}"

    source_connector_properties {
      salesforce {
        object                      = "Account"
        enable_dynamic_field_update = false
        include_deleted_records     = false
      }
    }
  }

  destination_flow_config {
    connector_type = "S3"

    destination_connector_properties {
      s3 {
        bucket_name = {{destination_bucket}}

        s3_output_format_config {
          file_type = "JSON"
        }
      }
    }
  }

  trigger_config {
    trigger_type = "Scheduled"

    trigger_properties {
      scheduled {
        schedule_expression = "rate({{schedule_rate_minutes}} minutes)"
      }
    }
  }

  task {
    source_fields     = ["Id", "Name"]
    destination_field = "Id"
    task_type         = "Filter"

    connector_operator {
      salesforce = "NO_OP"
    }
  }

  tags = {
    Name      = "{{flow_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cognito_user_pool_client', 'Cognito User Pool Client', 'App Integration', 'CUPC',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_user_pool_client","required":true},{"id":"client_name","label":"Client Name","type":"text","default":"my-app-client","required":true},{"id":"user_pool_id","label":"User Pool ID / Ref","type":"text","default":"aws_cognito_user_pool.main.id","required":true},{"id":"callback_urls","label":"Callback URLs (comma-sep)","type":"text","default":"https://app.example.com/callback"},{"id":"logout_urls","label":"Logout URLs (comma-sep)","type":"text","default":"https://app.example.com/logout"},{"id":"token_validity_hours","label":"Access Token Validity (hours)","type":"number","default":"1"},{"id":"generate_secret","label":"Generate Client Secret","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_cognito_user_pool_client" "{{name}}" {
  name         = "{{client_name}}"
  user_pool_id = {{user_pool_id}}

  generate_secret  = {{generate_secret}}
  callback_urls    = split(",", trimspace("{{callback_urls}}"))
  logout_urls      = split(",", trimspace("{{logout_urls}}"))

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["email", "openid", "profile"]
  supported_identity_providers         = ["COGNITO"]

  access_token_validity = {{token_validity_hours}}
  id_token_validity     = {{token_validity_hours}}

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudwatch_event_api_destination', 'EventBridge API Destination', 'App Integration', 'EBAPID',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_api_destination","required":true},{"id":"dest_name","label":"Destination Name","type":"text","default":"my-webhook","required":true},{"id":"invocation_endpoint","label":"Invocation Endpoint URL","type":"text","default":"https://api.example.com/events","required":true},{"id":"http_method","label":"HTTP Method","type":"select","options":["POST","GET","PUT","PATCH"],"default":"POST"},{"id":"invocation_rate","label":"Max Invocations/Second","type":"number","default":"300"},{"id":"api_key_name","label":"API Key Header Name","type":"text","default":"x-api-key"},{"id":"api_key_value","label":"API Key Value (use var)","type":"text","default":"var.webhook_api_key"}]',
  'resource "aws_cloudwatch_event_connection" "{{name}}" {
  name               = "{{dest_name}}-conn"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "{{api_key_name}}"
      value = {{api_key_value}}
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "{{name}}" {
  name                             = "{{dest_name}}"
  invocation_endpoint              = "{{invocation_endpoint}}"
  http_method                      = "{{http_method}}"
  invocation_rate_limit_per_second = {{invocation_rate}}
  connection_arn                   = aws_cloudwatch_event_connection.{{name}}.arn
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sqs_queue_redrive_policy', 'SQS Dead Letter Queue', 'App Integration', 'SQSDLQ',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_dlq","required":true},{"id":"queue_name","label":"DLQ Name","type":"text","default":"my-app-dlq","required":true},{"id":"source_queue_url","label":"Source Queue URL / Ref","type":"text","default":"aws_sqs_queue.main.url","required":true},{"id":"max_receive_count","label":"Max Receive Count Before DLQ","type":"number","default":"3"},{"id":"message_retention_seconds","label":"Message Retention (seconds)","type":"number","default":"1209600"}]',
  'resource "aws_sqs_queue" "{{name}}" {
  name                      = "{{queue_name}}"
  message_retention_seconds = {{message_retention_seconds}}

  tags = {
    Name      = "{{queue_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_sqs_queue_redrive_policy" "{{name}}" {
  queue_url = {{source_queue_url}}

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.{{name}}.arn
    maxReceiveCount     = {{max_receive_count}}
  })
}

resource "aws_cloudwatch_metric_alarm" "{{name}}_depth" {
  alarm_name          = "{{queue_name}}-has-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0

  dimensions = { QueueName = aws_sqs_queue.{{name}}.name }

  alarm_actions     = [aws_sns_topic.alerts.arn]
  alarm_description = "DLQ {{queue_name}} has messages - investigate!"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ─────────────────────────────────────────────────────────────────────────────
-- INFRASTRUCTURE & GOVERNANCE
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'cloudformation_stack', 'CloudFormation Stack', 'Admin & Ops', 'CFN',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_cfn_stack","required":true},{"id":"stack_name","label":"Stack Name","type":"text","default":"my-legacy-stack","required":true},{"id":"template_url","label":"Template S3 URL","type":"text","default":"https://s3.amazonaws.com/my-bucket/template.yaml","required":true},{"id":"capabilities","label":"Capabilities (comma-sep)","type":"text","default":"CAPABILITY_IAM, CAPABILITY_NAMED_IAM"},{"id":"on_failure","label":"On Failure","type":"select","options":["ROLLBACK","DO_NOTHING","DELETE"],"default":"ROLLBACK"},{"id":"timeout_minutes","label":"Timeout (minutes)","type":"number","default":"30"}]',
  'resource "aws_cloudformation_stack" "{{name}}" {
  name               = "{{stack_name}}"
  template_url       = "{{template_url}}"
  capabilities       = split(",", trimspace("{{capabilities}}"))
  on_failure         = "{{on_failure}}"
  timeout_in_minutes = {{timeout_minutes}}

  tags = {
    Name      = "{{stack_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc_ipam', 'VPC IP Address Manager (IPAM)', 'Networking', 'IPAM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ipam","required":true},{"id":"description","label":"Description","type":"text","default":"Centralized IP address management"},{"id":"operating_regions","label":"Operating Regions (comma-sep)","type":"text","default":"us-east-1, us-west-2, eu-west-1"}]',
  'resource "aws_vpc_ipam" "{{name}}" {
  description = "{{description}}"

  dynamic "operating_regions" {
    for_each = toset(split(",", trimspace("{{operating_regions}}")))
    content {
      region_name = trimspace(operating_regions.value)
    }
  }

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}

output "{{name}}_private_scope_id" {
  value = aws_vpc_ipam.{{name}}.private_default_scope_id
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'vpc_ipam_pool', 'VPC IPAM Pool', 'Networking', 'IPAMP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_ipam_pool","required":true},{"id":"ipam_scope_id","label":"IPAM Scope ID / Ref","type":"text","default":"aws_vpc_ipam.main.private_default_scope_id","required":true},{"id":"cidr","label":"CIDR Block","type":"text","default":"10.0.0.0/8","required":true},{"id":"address_family","label":"Address Family","type":"select","options":["ipv4","ipv6"],"default":"ipv4"},{"id":"locale","label":"Locale Region","type":"text","default":"us-east-1"},{"id":"description","label":"Description","type":"text","default":"Private IP pool"}]',
  'resource "aws_vpc_ipam_pool" "{{name}}" {
  address_family = "{{address_family}}"
  ipam_scope_id  = {{ipam_scope_id}}
  locale         = "{{locale}}"
  description    = "{{description}}"

  tags = {
    Name      = "{{name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_vpc_ipam_pool_cidr" "{{name}}" {
  ipam_pool_id = aws_vpc_ipam_pool.{{name}}.id
  cidr         = "{{cidr}}"
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'resourcegroups_group', 'Resource Groups', 'Admin & Ops', 'RG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_resource_group","required":true},{"id":"group_name","label":"Group Name","type":"text","default":"production-resources","required":true},{"id":"description","label":"Description","type":"text","default":"All production resources"},{"id":"tag_key","label":"Tag Key Filter","type":"text","default":"Environment"},{"id":"tag_value","label":"Tag Value Filter","type":"text","default":"production"}]',
  'resource "aws_resourcegroups_group" "{{name}}" {
  name        = "{{group_name}}"
  description = "{{description}}"

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [{
        Key    = "{{tag_key}}"
        Values = ["{{tag_value}}"]
      }]
    })
  }

  tags = {
    Name      = "{{group_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'ce_anomaly_monitor', 'Cost Anomaly Detection', 'Admin & Ops', 'CAD',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_anomaly_monitor","required":true},{"id":"monitor_name","label":"Monitor Name","type":"text","default":"total-cost-monitor","required":true},{"id":"monitor_type","label":"Monitor Type","type":"select","options":["DIMENSIONAL","CUSTOM"],"default":"DIMENSIONAL"},{"id":"monitor_dimension","label":"Dimension","type":"select","options":["SERVICE","MEMBER_ACCOUNT","COST_CATEGORY","USAGE_TYPE_GROUP"],"default":"SERVICE"},{"id":"threshold_amount","label":"Alert Threshold ($)","type":"number","default":"100"},{"id":"alert_email","label":"Alert Email","type":"text","default":"ops@example.com"}]',
  'resource "aws_ce_anomaly_monitor" "{{name}}" {
  name             = "{{monitor_name}}"
  monitor_type     = "{{monitor_type}}"
  monitor_dimension = "{{monitor_dimension}}"

  tags = {
    Name      = "{{monitor_name}}"
    ManagedBy = "Terraform"
  }
}

resource "aws_ce_anomaly_subscription" "{{name}}" {
  name      = "{{monitor_name}}-sub"
  frequency = "DAILY"

  monitor_arn_list = [aws_ce_anomaly_monitor.{{name}}.arn]

  subscriber {
    address = "{{alert_email}}"
    type    = "EMAIL"
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = ["{{threshold_amount}}"]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'fis_experiment_template', 'AWS FIS Chaos Engineering', 'Admin & Ops', 'FIS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_fis_experiment","required":true},{"id":"description","label":"Description","type":"text","default":"Terminate 10% of EC2 instances in staging"},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.fis.arn","required":true},{"id":"stop_condition_arn","label":"Stop Condition CloudWatch Alarm ARN / Ref","type":"text","default":"aws_cloudwatch_alarm.high_error_rate.arn"},{"id":"target_tag_key","label":"Target Resource Tag Key","type":"text","default":"Environment"},{"id":"target_tag_value","label":"Target Resource Tag Value","type":"text","default":"staging"},{"id":"action_id","label":"FIS Action ID","type":"select","options":["aws:ec2:terminate-instances","aws:ec2:stop-instances","aws:rds:failover-db-cluster","aws:eks:terminate-nodegroup-instances"],"default":"aws:ec2:terminate-instances"},{"id":"selection_mode","label":"Selection Mode","type":"select","options":["COUNT(1)","PERCENT(10)","ALL"],"default":"PERCENT(10)"}]',
  'resource "aws_fis_experiment_template" "{{name}}" {
  description = "{{description}}"
  role_arn    = {{role_arn}}

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = {{stop_condition_arn}}
  }

  action {
    name      = "main-action"
    action_id = "{{action_id}}"

    target {
      key   = "Instances"
      value = "target_instances"
    }
  }

  target {
    name           = "target_instances"
    resource_type  = "aws:ec2:instance"
    selection_mode = "{{selection_mode}}"

    resource_tag {
      key   = "{{target_tag_key}}"
      value = "{{target_tag_value}}"
    }
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
  'drs_replication_configuration_template', 'Elastic Disaster Recovery (DRS)', 'Admin & Ops', 'DRS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_drs","required":true},{"id":"staging_area_subnet_id","label":"Staging Subnet ID / Ref","type":"text","default":"aws_subnet.private_a.id","required":true},{"id":"replication_server_instance_type","label":"Replication Server Instance","type":"select","options":["t3.small","t3.medium","m5.large"],"default":"t3.small"},{"id":"use_dedicated_replication_server","label":"Dedicated Replication Server","type":"select","options":["false","true"],"default":"false"},{"id":"bandwidth_throttling","label":"Bandwidth Throttling Mbps (0=unlimited)","type":"number","default":"0"},{"id":"create_public_ip","label":"Create Public IP for Replication","type":"select","options":["false","true"],"default":"false"}]',
  'resource "aws_drs_replication_configuration_template" "{{name}}" {
  staging_area_subnet_id           = {{staging_area_subnet_id}}
  replication_server_instance_type = "{{replication_server_instance_type}}"
  use_dedicated_replication_server = {{use_dedicated_replication_server}}
  bandwidth_throttling             = {{bandwidth_throttling}}
  create_public_ip                 = {{create_public_ip}}

  replication_servers_security_groups_ids = [
    aws_security_group.drs_replication.id
  ]

  pit_policy {
    enabled            = true
    interval           = 10
    retention_duration = 60
    units              = "MINUTE"
    rule_id            = 1
  }

  staging_area_tags = { ManagedBy = "Terraform" }

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
-- MACHINE LEARNING
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sagemaker_domain', 'SageMaker Studio Domain', 'Machine Learning', 'SMDOM',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sagemaker_domain","required":true},{"id":"domain_name","label":"Domain Name","type":"text","default":"my-ml-studio","required":true},{"id":"auth_mode","label":"Auth Mode","type":"select","options":["IAM","SSO"],"default":"IAM"},{"id":"vpc_id","label":"VPC ID / Ref","type":"text","default":"aws_vpc.main.id","required":true},{"id":"subnet_ids","label":"Subnet IDs (comma-sep)","type":"text","default":"aws_subnet.private_a.id","required":true},{"id":"execution_role_arn","label":"Default Execution Role ARN / Ref","type":"text","default":"aws_iam_role.sagemaker_studio.arn","required":true},{"id":"instance_type","label":"Default Kernel Instance Type","type":"select","options":["ml.t3.medium","ml.t3.large","ml.m5.large","ml.m5.xlarge","ml.g4dn.xlarge"],"default":"ml.t3.medium"}]',
  'resource "aws_sagemaker_domain" "{{name}}" {
  domain_name = "{{domain_name}}"
  auth_mode   = "{{auth_mode}}"
  vpc_id      = {{vpc_id}}
  subnet_ids  = [{{subnet_ids}}]

  default_user_settings {
    execution_role = {{execution_role_arn}}

    jupyter_server_app_settings {
      default_resource_spec {
        instance_type = "system"
      }
    }

    kernel_gateway_app_settings {
      default_resource_spec {
        instance_type = "{{instance_type}}"
      }
    }
  }

  app_network_access_type = "VpcOnly"

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
  'sagemaker_pipeline', 'SageMaker ML Pipeline', 'Machine Learning', 'SMPL',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_sm_pipeline","required":true},{"id":"pipeline_name","label":"Pipeline Name","type":"text","default":"my-ml-pipeline","required":true},{"id":"description","label":"Description","type":"text","default":"ML training pipeline"},{"id":"role_arn","label":"Execution Role ARN / Ref","type":"text","default":"aws_iam_role.sagemaker_pipeline.arn","required":true},{"id":"instance_type","label":"Processing Instance Type","type":"select","options":["ml.t3.medium","ml.m5.large","ml.m5.xlarge","ml.c5.xlarge","ml.g4dn.xlarge"],"default":"ml.m5.large"}]',
  'resource "aws_sagemaker_pipeline" "{{name}}" {
  pipeline_name         = "{{pipeline_name}}"
  pipeline_display_name = "{{pipeline_name}}"
  pipeline_description  = "{{description}}"
  role_arn              = {{role_arn}}

  pipeline_definition = jsonencode({
    Version = "2020-12-01"
    Steps = [
      {
        Name = "PreprocessingStep"
        Type = "Processing"
        Arguments = {
          ProcessingResources = {
            ClusterConfig = {
              InstanceCount  = 1
              InstanceType   = "{{instance_type}}"
              VolumeSizeInGB = 30
            }
          }
        }
      }
    ]
  })

  tags = {
    Name      = "{{pipeline_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'sagemaker_feature_group', 'SageMaker Feature Store', 'Machine Learning', 'SMFS',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_feature_group","required":true},{"id":"feature_group_name","label":"Feature Group Name","type":"text","default":"my-features","required":true},{"id":"record_identifier","label":"Record Identifier Feature Name","type":"text","default":"customer_id","required":true},{"id":"event_time_feature","label":"Event Time Feature Name","type":"text","default":"event_time","required":true},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.feature_store.arn","required":true},{"id":"s3_uri","label":"Offline Store S3 URI","type":"text","default":"s3://my-feature-store/"},{"id":"enable_online","label":"Enable Online Store","type":"select","options":["true","false"],"default":"true"}]',
  'resource "aws_sagemaker_feature_group" "{{name}}" {
  feature_group_name             = "{{feature_group_name}}"
  record_identifier_feature_name = "{{record_identifier}}"
  event_time_feature_name        = "{{event_time_feature}}"
  role_arn                       = {{role_arn}}

  feature_definition {
    feature_name = "{{record_identifier}}"
    feature_type = "Integral"
  }

  feature_definition {
    feature_name = "{{event_time_feature}}"
    feature_type = "String"
  }

  online_store_config {
    enable_online_store = {{enable_online}}
  }

  offline_store_config {
    s3_storage_config {
      s3_uri = "{{s3_uri}}"
    }
    disable_glue_table_creation = false
  }

  tags = {
    Name      = "{{feature_group_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'rekognition_collection', 'Amazon Rekognition Collection', 'Machine Learning', 'REKG',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_rekognition","required":true},{"id":"collection_id","label":"Collection ID","type":"text","default":"my-face-collection","required":true}]',
  'resource "aws_rekognition_collection" "{{name}}" {
  collection_id = "{{collection_id}}"

  tags = {
    Name      = "{{collection_id}}"
    ManagedBy = "Terraform"
  }
}

output "{{name}}_arn" {
  value = aws_rekognition_collection.{{name}}.arn
}

output "{{name}}_face_model_version" {
  value = aws_rekognition_collection.{{name}}.face_model_version
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'comprehend_entity_recognizer', 'Amazon Comprehend Entity Recognizer', 'Machine Learning', 'COMP',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_comprehend","required":true},{"id":"model_name","label":"Recognizer Name","type":"text","default":"my-entity-recognizer","required":true},{"id":"language_code","label":"Language Code","type":"select","options":["en","es","fr","de","it","pt","ar","hi","ja","ko","zh"],"default":"en"},{"id":"data_role_arn","label":"IAM Role ARN / Ref (S3 access)","type":"text","default":"aws_iam_role.comprehend.arn","required":true},{"id":"entity_type","label":"Entity Type","type":"text","default":"PRODUCT"},{"id":"documents_s3_uri","label":"Training Documents S3 URI","type":"text","default":"s3://my-nlp-data/train/"},{"id":"annotations_s3_uri","label":"Annotations S3 URI","type":"text","default":"s3://my-nlp-data/annotations/"}]',
  'resource "aws_comprehend_entity_recognizer" "{{name}}" {
  name                 = "{{model_name}}"
  language_code        = "{{language_code}}"
  data_access_role_arn = {{data_role_arn}}

  input_data_config {
    entity_types {
      type = "{{entity_type}}"
    }

    documents {
      s3_uri = "{{documents_s3_uri}}"
    }

    annotations {
      s3_uri = "{{annotations_s3_uri}}"
    }
  }

  tags = {
    Name      = "{{model_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

INSERT INTO templates (service_type, label, category, icon, schema_def, template_body, module_body) VALUES (
  'bedrock_custom_model', 'Amazon Bedrock Custom Model', 'Machine Learning', 'BRCK',
  '[{"id":"name","label":"Resource Name","type":"text","default":"my_bedrock_model","required":true},{"id":"job_name","label":"Fine-Tuning Job Name","type":"text","default":"my-finetuning-job","required":true},{"id":"custom_model_name","label":"Custom Model Name","type":"text","default":"my-custom-llm","required":true},{"id":"base_model_id","label":"Base Model ID","type":"select","options":["amazon.titan-text-lite-v1","amazon.titan-text-express-v1","cohere.command-light-text-v14","cohere.command-text-v14","amazon.nova-lite-v1:0","amazon.nova-micro-v1:0"],"default":"amazon.titan-text-express-v1"},{"id":"customization_type","label":"Customization Type","type":"select","options":["FINE_TUNING","CONTINUED_PRE_TRAINING"],"default":"FINE_TUNING"},{"id":"role_arn","label":"IAM Role ARN / Ref","type":"text","default":"aws_iam_role.bedrock_customization.arn","required":true},{"id":"training_s3_uri","label":"Training Data S3 URI","type":"text","default":"s3://my-training-data/train.jsonl"},{"id":"output_s3_uri","label":"Output S3 URI","type":"text","default":"s3://my-model-output/"}]',
  'resource "aws_bedrock_custom_model" "{{name}}" {
  custom_model_name     = "{{custom_model_name}}"
  job_name              = "{{job_name}}"
  base_model_identifier = "{{base_model_id}}"
  customization_type    = "{{customization_type}}"
  role_arn              = {{role_arn}}

  training_data_config {
    s3_uri = "{{training_s3_uri}}"
  }

  output_data_config {
    s3_uri = "{{output_s3_uri}}"
  }

  hyper_parameters = {
    epochCount              = "3"
    batchSize               = "1"
    learningRate            = "0.00001"
    learningRateWarmupSteps = "0"
  }

  tags = {
    Name      = "{{custom_model_name}}"
    ManagedBy = "Terraform"
  }
}',
  NULL
) ON CONFLICT (service_type) DO UPDATE SET
  label=EXCLUDED.label, schema_def=EXCLUDED.schema_def,
  template_body=EXCLUDED.template_body, module_body=EXCLUDED.module_body;

-- ═══════════════════════════════════════════════════════════════════════════
-- End of migrate_v9_missing_services.sql
-- Total new services added: 81
-- ═══════════════════════════════════════════════════════════════════════════


-- ------------------------------------------------------------
-- SOURCE: fix_project_versions_owner.sql
-- ------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────────
-- One-time admin fix: make tfgen the owner of public.project_versions
-- Run as: postgres (or superuser)
--
-- File: fix_project_versions_owner.sql  (was incorrectly named migrate_v6.sql)
--
-- Usage examples:
--   sudo -u postgres psql -d terraform_generator -f database/fix_project_versions_owner.sql
--   psql -U postgres -h localhost -d terraform_generator -f database/fix_project_versions_owner.sql
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

DO $$
DECLARE
  tbl_owner text;
BEGIN
  -- Ensure tfgen role exists
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tfgen') THEN
    RAISE EXCEPTION 'Role "tfgen" does not exist. Create it first, then re-run.';
  END IF;

  -- Identify current owner
  SELECT r.rolname INTO tbl_owner
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'project_versions'
    AND c.relkind = 'r';

  IF tbl_owner IS NULL THEN
    RAISE EXCEPTION 'Table public.project_versions does not exist.';
  END IF;

  RAISE NOTICE 'Current owner of public.project_versions = %', tbl_owner;
END $$;

-- Transfer ownership (requires postgres/superuser or current table owner)
ALTER TABLE public.project_versions OWNER TO tfgen;

-- Confirm
SELECT n.nspname AS schema, c.relname AS table, r.rolname AS owner
FROM pg_class c
JOIN pg_roles r ON r.oid = c.relowner
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relname='project_versions' AND c.relkind='r';

