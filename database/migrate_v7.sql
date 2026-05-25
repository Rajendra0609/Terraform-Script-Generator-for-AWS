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

