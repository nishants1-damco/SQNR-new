# PostgreSQL 16 with PostGIS and pgvector (migration plan §8.1). Neither
# official image ships both; the PostGIS image already has the PGDG apt
# repository configured, so pgvector installs from there.
FROM postgis/postgis:16-3.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-pgvector \
  && rm -rf /var/lib/apt/lists/*
