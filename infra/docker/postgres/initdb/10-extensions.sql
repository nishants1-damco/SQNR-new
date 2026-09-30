-- Runs once, on first start of an empty data volume (after the PostGIS
-- image's own init scripts). Extensions the schema needs (plan §8):
--   postgis  - geometry columns on scans, photos, objects, portals, surfaces, layers
--   vector   - product_dimensions.embedding and match_product_catalog()
--   citext   - case-insensitive users.email
--   pg_trgm  - trigram index for catalog name search
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
