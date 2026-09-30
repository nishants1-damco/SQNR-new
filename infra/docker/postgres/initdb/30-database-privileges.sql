-- Per-database setup, run as a superuser in the target database. Used by
-- initdb for `spatial`, and by @spatial/db's test helper for each throwaway
-- test database (together with 10-extensions.sql).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_migrator, app_rw', current_database());
END $$;

ALTER SCHEMA public OWNER TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_rw;

-- Everything the migrator creates is usable, but not alterable, by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_rw;

-- PostGIS reference table, created by the superuser with the extension.
GRANT SELECT ON public.spatial_ref_sys TO app_rw, app_migrator;
