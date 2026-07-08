FROM postgres:15-alpine



LABEL maintainer="daggu1997"
LABEL description="Custom PostgreSQL image with schema, seed, and migrations"

COPY schema.sql /docker-entrypoint-initdb.d/01-schema.sql
COPY seed.sql /docker-entrypoint-initdb.d/02-seed.sql
COPY fix_project_versions_owner.sql /docker-entrypoint-initdb.d/03-fix_project_versions_owner.sql
COPY migrate.sql /docker-entrypoint-initdb.d/04-migrate.sql
COPY migrate_v5_columns.sql /docker-entrypoint-initdb.d/05-migrate_v5_columns.sql
COPY migrate_v6.sql /docker-entrypoint-initdb.d/06-migrate_v6.sql
COPY migrate_v7.sql /docker-entrypoint-initdb.d/07-migrate_v7.sql
COPY migrate_v8_more_services.sql /docker-entrypoint-initdb.d/08-migrate_v8_more_services.sql
COPY migrate_v9_missing_services.sql /docker-entrypoint-initdb.d/09-migrate_v9_missing_services.sql
# SECURITY FIX (C-13): these three were previously absent from this image
# entirely. 011 is the ONLY place oauth_provider/oauth_subject/display_name/
# avatar_url/last_login_at were ever defined, and 010 fixes two templates that
# fail `terraform validate`. Neither ran on any deployment built from this
# Dockerfile — the OAuth login feature failed for 100% of users with a masked
# "column does not exist" error. Numeric order matters: docker-entrypoint.sh
# runs /docker-entrypoint-initdb.d/* in lexicographic filename order.
COPY 010_fix_template_validation.sql /docker-entrypoint-initdb.d/10-fix_template_validation.sql
COPY 011_phases_2_5_governance_collab_notifications.sql /docker-entrypoint-initdb.d/11-phases_2_5_governance_collab_notifications.sql
COPY 012_security_hardening_c11_c13.sql /docker-entrypoint-initdb.d/12-security_hardening_c11_c13.sql

