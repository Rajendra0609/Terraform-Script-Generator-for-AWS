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

