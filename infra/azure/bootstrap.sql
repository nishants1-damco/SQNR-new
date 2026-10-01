-- One-time setup of the `spatial` database on Azure Database for PostgreSQL,
-- run as the server's administrator (spatialadmin) after the first
-- deployment. The same steps as infra/docker/postgres/initdb for local
-- development, with real passwords:
--
--   psql "host=<server>.postgres.database.azure.com dbname=spatial user=spatialadmin sslmode=require" \
--     -v app_migrator_password="$APP_MIGRATOR_PASSWORD" -v app_rw_password="$APP_RW_PASSWORD" \
--     -f infra/azure/bootstrap.sql
--
-- The passwords must match APP_MIGRATOR_PASSWORD / APP_RW_PASSWORD given to
-- main.bicep, which builds the connection strings in Key Vault from them.

-- Extensions (allowlisted on the server by main.bicep).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- app_migrator owns the schema and runs migrations (directly, port 5432);
-- app_rw is what the API and worker use (through PgBouncer, port 6432).
CREATE ROLE app_migrator LOGIN PASSWORD :'app_migrator_password';
CREATE ROLE app_rw LOGIN PASSWORD :'app_rw_password';
GRANT app_migrator TO spatialadmin;

GRANT CONNECT ON DATABASE spatial TO app_migrator, app_rw;
ALTER SCHEMA public OWNER TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_rw;

-- Everything the migrator creates is usable, but not alterable, by the apps.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_rw;

GRANT SELECT ON public.spatial_ref_sys TO app_rw, app_migrator;
