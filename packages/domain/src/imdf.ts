/**
 * IMDF (Apple Indoor Mapping Data Format) builder.
 *
 * Converts a scan_export payload — whose geometry lives in a room-centered
 * metric CRS — into the fixed set of WGS84 GeoJSON files that make up an
 * IMDF archive.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Feature = { type: "Feature"; id?: string; geometry: Json; properties: Record<string, Json> };

export interface ImdfArchive {
  /** file name -> parsed JSON contents */
  files: Record<string, Json>;
  /** ordered file list with feature counts, for UI */
  index: { file: string; features: number }[];
  georeferenced: boolean;
  origin: { lon: number; lat: number } | null;
  north_offset_deg: number;
  /** Inferred or user-supplied site address, if any. */
  address: string | null;
}

const EXT = "sqnr";

/** Deterministic RFC-4122-shaped id derived from a stable key. */
export function stableId(seed: string): string {
  // 128 bits from four independent FNV-1a passes over salted input.
  const fnv = (s: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const parts = [fnv(seed), fnv(`a|${seed}`), fnv(`b|${seed}`), fnv(`c|${seed}`)];
  const hex = parts.map((p) => p.toString(16).padStart(8, "0")).join("");
  const v = `${hex.slice(0, 12)}5${hex.slice(13, 16)}a${hex.slice(17, 32)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

function parsePoint(wkt: unknown): { lon: number; lat: number } | null {
  if (typeof wkt !== "string") return null;
  const m = /POINT\s*[ZM]*\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(wkt);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

/** Local meters (X east, Y north) -> WGS84 lon/lat, rotated onto true north. */
function makeProjector(origin: { lon: number; lat: number }, northOffsetDeg: number) {
  const rad = (northOffsetDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mPerDegLat = 111_320;
  const mPerDegLon = Math.max(111_320 * Math.cos((origin.lat * Math.PI) / 180), 1e-6);
  return (x: number, y: number): [number, number] => {
    const east = x * cos + y * sin;
    const north = -x * sin + y * cos;
    return [
      Number((origin.lon + east / mPerDegLon).toFixed(9)),
      Number((origin.lat + north / mPerDegLat).toFixed(9)),
    ];
  };
}

type Proj = (x: number, y: number) => [number, number];

function projectGeometry(geom: Json, proj: Proj): Json {
  if (!geom || typeof geom !== "object" || Array.isArray(geom)) return null;
  const g = geom as { type?: string; coordinates?: Json };
  const walk = (c: Json, depth: number): Json => {
    if (depth === 0) {
      const arr = c as number[];
      return proj(Number(arr[0] ?? 0), Number(arr[1] ?? 0)) as unknown as Json;
    }
    return (c as Json[]).map((v) => walk(v, depth - 1));
  };
  const depths: Record<string, number> = {
    Point: 0,
    LineString: 1,
    MultiPoint: 1,
    Polygon: 2,
    MultiLineString: 2,
    MultiPolygon: 3,
  };
  const d = depths[String(g.type)];
  if (d === undefined || g.coordinates === undefined) return null;
  return { type: g.type as Json, coordinates: walk(g.coordinates as Json, d) };
}

function labels(name: string): Record<string, Json> {
  return { en: name };
}

function openingCategory(kind: string) {
  const k = kind.toLowerCase();
  if (k.includes("window")) return "pedestrian.principal"; // non-traversable flagged below
  if (k.includes("arch") || k.includes("opening")) return "pedestrian";
  return "pedestrian";
}

function fixtureCategory(category: string, label: string) {
  const s = `${category} ${label}`.toLowerCase();
  if (/(sofa|couch|chair|stool|bench|seat)/.test(s)) return "seating";
  if (/(table|desk|piano|cabinet|shelf|bookcase|dresser)/.test(s)) return "furniture";
  if (/(plant|tree)/.test(s)) return "obstruction";
  if (/(tv|screen|monitor|speaker|projector)/.test(s)) return "equipment";
  return "obstruction";
}

/** Builds the IMDF archive from a scan_export payload. */
export function buildImdf(payload: {
  geojson: { [key: string]: Json };
  postgis: { [key: string]: Json };
  layers: Json[];
}): ImdfArchive {
  const features = ((payload.geojson?.["features"] as Feature[] | undefined) ?? []).filter(
    (f) => f && typeof f === "object",
  );
  const scanRow =
    ((payload.postgis?.["scans"] as Record<string, Json>[] | undefined) ?? [])[0] ?? {};

  const scanId = String(scanRow["id"] ?? "scan");
  const scanName = String(scanRow["name"] ?? "Space");
  const address = scanRow["site_address"] == null ? null : String(scanRow["site_address"]);
  const northOffset = Number(scanRow["north_offset_deg"] ?? 0) || 0;
  const origin = parsePoint(scanRow["site_location"]);
  const georeferenced = origin !== null;
  const proj = makeProjector(origin ?? { lon: 0, lat: 0 }, northOffset);

  const venueId = stableId(`venue:${scanId}`);
  const buildingId = stableId(`building:${scanId}`);
  const levelId = stableId(`level:${scanId}`);
  const addressId = stableId(`address:${scanId}`);
  const unitId = stableId(`unit:${scanId}`);
  const footprintId = stableId(`footprint:${scanId}`);
  const anchorId = stableId(`anchor:${scanId}`);

  const by = (entity: string) =>
    features.filter((f) => String(f.properties?.["entity"] ?? "") === entity);

  const room = by("room_footprint")[0];
  const roomGeom = room ? projectGeometry(room.geometry, proj) : null;

  const displayPoint = (): Json => ({
    type: "Point",
    coordinates: proj(0, 0) as unknown as Json,
  });

  const scanExt = {
    [`${EXT}:scan_id`]: scanId,
    [`${EXT}:lod_level`]: (scanRow["lod_level"] ?? null) as Json,
    [`${EXT}:width_m`]: (scanRow["width_m"] ?? null) as Json,
    [`${EXT}:length_m`]: (scanRow["length_m"] ?? null) as Json,
    [`${EXT}:height_m`]: (scanRow["height_m"] ?? null) as Json,
    [`${EXT}:volume_m3`]: (scanRow["volume_m3"] ?? null) as Json,
    [`${EXT}:acoustics`]: (scanRow["acoustics"] ?? null) as Json,
    [`${EXT}:georeferenced`]: georeferenced,
  } satisfies Record<string, Json>;

  const venue: Feature = {
    type: "Feature",
    id: venueId,
    geometry: roomGeom,
    properties: {
      category: "businesscampus",
      restriction: null,
      name: labels(scanName),
      alt_name: null,
      hours: null,
      phone: null,
      website: null,
      display_point: displayPoint(),
      address_id: addressId,
      ...scanExt,
    },
  };

  const building: Feature = {
    type: "Feature",
    id: buildingId,
    geometry: roomGeom,
    properties: {
      category: "unspecified",
      restriction: null,
      name: labels(scanName),
      alt_name: null,
      display_point: displayPoint(),
      address_id: addressId,
    },
  };

  const level: Feature = {
    type: "Feature",
    id: levelId,
    geometry: roomGeom,
    properties: {
      category: "unspecified",
      restriction: null,
      outdoor: false,
      ordinal: 0,
      name: labels("Level 0"),
      short_name: labels("L0"),
      display_point: displayPoint(),
      address_id: addressId,
      building_ids: [buildingId],
    },
  };

  const footprint: Feature = {
    type: "Feature",
    id: footprintId,
    geometry: roomGeom,
    properties: {
      category: "aerial",
      name: labels(scanName),
      building_ids: [buildingId],
    },
  };

  const unit: Feature = {
    type: "Feature",
    id: unitId,
    geometry: roomGeom,
    properties: {
      category: "room",
      restriction: null,
      accessibility: null,
      name: labels(scanName),
      alt_name: null,
      display_point: displayPoint(),
      level_id: levelId,
      ...scanExt,
    },
  };

  const openings: Feature[] = by("portal").map((p) => {
    const kind = String(p.properties?.["kind"] ?? "door");
    const isWindow = kind.toLowerCase().includes("window");
    return {
      type: "Feature",
      id: stableId(`opening:${p.properties?.["id"] ?? p.id}`),
      geometry: projectGeometry(p.geometry, proj),
      properties: {
        category: openingCategory(kind),
        accessibility: null,
        access_control: null,
        door: isWindow
          ? null
          : {
              type: kind.toLowerCase().includes("arch") ? "open" : "swinging",
              automatic: false,
              material: null,
            },
        name: labels(kind),
        alt_name: null,
        display_point: null,
        level_id: levelId,
        unit_ids: [unitId],
        [`${EXT}:kind`]: kind,
        [`${EXT}:wall`]: (p.properties?.["wall"] ?? null) as Json,
        [`${EXT}:width_m`]: (p.properties?.["width_m"] ?? null) as Json,
        [`${EXT}:height_m`]: (p.properties?.["height_m"] ?? null) as Json,
        [`${EXT}:traversable`]: !isWindow,
        [`${EXT}:confidence`]: (p.properties?.["confidence"] ?? null) as Json,
      },
    };
  });

  const fixtures: Feature[] = by("object").map((o) => {
    const label = String(o.properties?.["label"] ?? "object");
    const category = String(o.properties?.["category"] ?? "");
    return {
      type: "Feature",
      id: stableId(`fixture:${o.properties?.["id"] ?? o.id}`),
      geometry: projectGeometry(o.geometry, proj),
      properties: {
        category: fixtureCategory(category, label),
        restriction: null,
        name: labels(label),
        alt_name: null,
        display_point:
          o.properties?.["x_m"] == null
            ? null
            : {
                type: "Point",
                coordinates: proj(
                  Number(o.properties?.["x_m"] ?? 0),
                  Number(o.properties?.["y_m"] ?? 0),
                ) as unknown as Json,
              },
        level_id: levelId,
        [`${EXT}:source_category`]: category || null,
        [`${EXT}:confidence`]: (o.properties?.["confidence"] ?? null) as Json,
        [`${EXT}:height_m`]: (o.properties?.["height_m"] ?? null) as Json,
        [`${EXT}:attributes`]: (o.properties?.["attributes"] ?? null) as Json,
      },
    };
  });

  const addressFeature: Feature = {
    type: "Feature",
    id: addressId,
    geometry: null,
    properties: {
      address: address ?? "Unknown",
      unit: null,
      locality: "",
      province: null,
      country: "",
      postal_code: null,
      postal_code_ext: null,
      postal_code_vanity: null,
    },
  };

  const anchor: Feature = {
    type: "Feature",
    id: anchorId,
    geometry: displayPoint(),
    properties: {
      address_id: addressId,
      unit_id: unitId,
    },
  };

  const fc = (feats: Feature[]): Json =>
    ({ type: "FeatureCollection", name: "", features: feats as unknown as Json[] }) as Json;

  const manifest: Json = {
    version: "1.0.0",
    created: new Date().toISOString(),
    generated_by: "SQNR Vector Capture",
    language: "en",
    extensions: [
      {
        name: EXT,
        version: "1.0.0",
        description: "SQNR spatial capture attributes (acoustics, confidence, materials)",
      },
    ],
  };

  const files: Record<string, Json> = {
    "manifest.json": manifest,
    "address.geojson": fc([addressFeature]),
    "venue.geojson": fc([venue]),
    "building.geojson": fc([building]),
    "footprint.geojson": fc([footprint]),
    "level.geojson": fc([level]),
    "unit.geojson": fc([unit]),
    "opening.geojson": fc(openings),
    "fixture.geojson": fc(fixtures),
    "anchor.geojson": fc([anchor]),
  };

  const index = Object.entries(files).map(([file, content]) => ({
    file,
    features: Array.isArray((content as { features?: unknown[] }).features)
      ? ((content as { features: unknown[] }).features.length as number)
      : 0,
  }));

  return { files, index, georeferenced, origin, north_offset_deg: northOffset, address };
}
