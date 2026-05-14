CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role       VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  aws_region  VARCHAR(50) DEFAULT 'ap-south-1',
  environment VARCHAR(50) DEFAULT 'dev',
  backend_config JSONB DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  service_type  VARCHAR(100),
  resource_name VARCHAR(255),
  config        JSONB,
  variables     JSONB DEFAULT '{}',
  outputs       JSONB DEFAULT '{}',
  is_module     BOOLEAN DEFAULT false,
  module_source VARCHAR(500),
  hcl_output    TEXT,
  position      INT DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  source      VARCHAR(500),
  version     VARCHAR(50),
  description TEXT,
  schema_def  JSONB,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type  VARCHAR(100) UNIQUE,
  cloud_provider VARCHAR(20) DEFAULT 'aws',
  label         VARCHAR(255),
  category      VARCHAR(100),
  icon          VARCHAR(50),
  is_module     BOOLEAN DEFAULT false,
  schema_def    JSONB,
  template_body TEXT,
  module_body   TEXT,
  data_sources  JSONB DEFAULT '[]',
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  version_number INT,
  full_hcl       TEXT,
  variables_hcl  TEXT,
  outputs_hcl    TEXT,
  resource_count INT DEFAULT 0,
  saved_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS validation_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  is_valid   BOOLEAN,
  diagnostics JSONB,
  ran_at     TIMESTAMP DEFAULT NOW()
);

-- Upgrade existing schema when tables already exist
DO $$
BEGIN
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS environment VARCHAR(50) DEFAULT 'dev';
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS backend_config JSONB DEFAULT '{}';
  ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS user_id UUID;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE projects: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '{}';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS outputs JSONB DEFAULT '{}';
  ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS module_source VARCHAR(500);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE resources: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE templates: insufficient privilege or not owner';
END
$$;

DO $$
BEGIN
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS variables_hcl TEXT;
  ALTER TABLE project_versions
    ADD COLUMN IF NOT EXISTS outputs_hcl TEXT;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping ALTER TABLE project_versions: insufficient privilege or not owner';
END
$$;
