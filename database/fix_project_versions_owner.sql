-- ─────────────────────────────────────────────────────────────────────────────
-- One-time admin fix: make tfgen the owner of public.project_versions
--
-- BUG-FIX: The original file had three problems that caused docker-compose
-- to abort during postgres initialisation:
--
--  1. \set ON_ERROR_STOP on — in docker-entrypoint-initdb.d, psql already
--     runs with -v ON_ERROR_STOP=1. Repeating it is harmless, but the
--     original RAISE EXCEPTION inside the DO block (when 'tfgen' role was
--     not found) combined with ON_ERROR_STOP meant a missing role killed the
--     entire postgres init sequence and no subsequent SQL files ran at all.
--
--  2. RAISE EXCEPTION for a missing role is too aggressive for an init
--     script. The tfgen role IS the docker POSTGRES_USER so it always exists
--     in the container, but any environment that uses a different superuser
--     name would permanently break. Changed to RAISE NOTICE + graceful exit.
--
--  3. The bare ALTER TABLE ... OWNER TO tfgen outside any exception handler
--     would abort with ON_ERROR_STOP=1 if the current session user doesn't
--     have superuser or table-ownership rights. Wrapped in DO/EXCEPTION.
--
-- Usage (manual, optional):
--   psql -U postgres -h localhost -d terraform_generator \
--        -f database/fix_project_versions_owner.sql
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  tbl_owner text;
BEGIN
  -- Gracefully skip if 'tfgen' role doesn't exist in this environment.
  -- In docker-compose POSTGRES_USER=tfgen so it will always be found.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tfgen') THEN
    RAISE NOTICE 'Role "tfgen" does not exist in this environment — skipping ownership transfer.';
    RETURN;
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
    RAISE NOTICE 'Table public.project_versions does not exist yet — skipping ownership transfer.';
    RETURN;
  END IF;

  IF tbl_owner = 'tfgen' THEN
    RAISE NOTICE 'public.project_versions is already owned by tfgen — nothing to do.';
    RETURN;
  END IF;

  RAISE NOTICE 'Transferring ownership of public.project_versions from % to tfgen', tbl_owner;
END $$;

-- Transfer ownership only if tfgen role exists and current user has rights.
-- BUG-FIX: wrapped in DO block so a privilege error is caught and reported
-- as a NOTICE rather than aborting the entire init sequence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tfgen') THEN
    EXECUTE 'ALTER TABLE public.project_versions OWNER TO tfgen';
    RAISE NOTICE 'Ownership of public.project_versions transferred to tfgen.';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping OWNER TO tfgen: insufficient privilege (run as superuser if needed).';
WHEN OTHERS THEN
  RAISE NOTICE 'Skipping ownership transfer: %', SQLERRM;
END $$;

-- Confirm current state
SELECT n.nspname AS schema, c.relname AS table, r.rolname AS owner
FROM pg_class c
JOIN pg_roles r ON r.oid = c.relowner
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'project_versions' AND c.relkind = 'r';
