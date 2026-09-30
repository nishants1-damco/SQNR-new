-- Two application roles (plan §8.2). Local development passwords only;
-- production credentials come from Key Vault.
--   app_migrator - owns the schema and runs migrations (connects directly)
--   app_rw       - used by apps/api and apps/worker (connects through PgBouncer)
CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev';
CREATE ROLE app_rw LOGIN PASSWORD 'app_rw_dev';

GRANT CONNECT ON DATABASE spatial TO app_migrator, app_rw;
ALTER SCHEMA public OWNER TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_rw;

-- Everything the migrator creates is usable, but not alterable, by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_rw;

-- PostGIS reference table, created by the superuser above.
GRANT SELECT ON public.spatial_ref_sys TO app_rw, app_migrator;
