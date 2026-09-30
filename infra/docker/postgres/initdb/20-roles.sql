-- Cluster-wide application roles (plan §8.2). Local development passwords
-- only; production credentials come from Key Vault.
--   app_migrator - owns the schema and runs migrations (connects directly)
--   app_rw       - used by apps/api and apps/worker (connects through PgBouncer)
CREATE ROLE app_migrator LOGIN PASSWORD 'app_migrator_dev';
CREATE ROLE app_rw LOGIN PASSWORD 'app_rw_dev';
