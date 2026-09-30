// Column types Drizzle doesn't ship. Geometry and geography values come back
// from node-postgres as hex EWKB strings; queries that need coordinates use
// PostGIS functions (ST_AsGeoJSON, ST_AsText) in SQL.
import { customType } from "drizzle-orm/pg-core";

type Spatial = { data: string; driverData: string; config: { type: string; srid: number } };

const geometryType = customType<Spatial>({
  dataType: (config) => `geometry(${config?.type ?? "Geometry"}, ${config?.srid ?? 0})`,
});

const geographyType = customType<Spatial>({
  dataType: (config) => `geography(${config?.type ?? "Geometry"}, ${config?.srid ?? 4326})`,
});

/** PostGIS geometry with a subtype, e.g. geometry("footprint", "Polygon"). SRID 0 = room-local metres. */
export const geometry = (name: string, type: string, srid = 0) =>
  geometryType(name, { type, srid });

/** PostGIS geography, WGS 84 by default. */
export const geography = (name: string, type: string, srid = 4326) =>
  geographyType(name, { type, srid });

/** Case-insensitive text (the citext extension). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => "citext",
});
