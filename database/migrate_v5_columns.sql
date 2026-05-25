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
