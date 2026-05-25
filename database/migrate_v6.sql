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
