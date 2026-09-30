/**
 * OpenUSD / USDA scene builder.
 *
 * Converts a scan_export payload into a human-readable `.usda` text scene
 * and the metadata needed to package it as a `.usdz` archive client-side.
 *
 * The output is a clean parametric solid model: floor, ceiling, walls,
 * openings and objects, with SQNR-specific attributes stored in customData.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Feature = { type: "Feature"; id?: string; geometry: Json; properties: Record<string, Json> };
type Point2 = [number, number];
type Ring = Point2[];

export interface UsdArchive {
  /** Raw USDA scene text. */
  usda: string;
  /** Prim counts for the UI summary. */
  prims: { shell: number; objects: number; openings: number; materials: number };
  /** Whether a room shell could be reconstructed. */
  hasShell: boolean;
}

const EXT = "sqnr";

function sanitize(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^[0-9]/, (d) => `_${d}`)
      .slice(0, 48) || "prim"
  );
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

function usdString(v: string): string {
  return JSON.stringify(v);
}

function usdFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function usdArray<T>(arr: T[], fmt: (v: T) => string): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map(fmt).join(", ")}]`;
}

function usdPoint3f(x: number, y: number, z: number): string {
  return `(${usdFloat(x)}, ${usdFloat(y)}, ${usdFloat(z)})`;
}

function usdColor3f(r: number, g: number, b: number): string {
  return `(${usdFloat(r)}, ${usdFloat(g)}, ${usdFloat(b)})`;
}

function parsePoint(wkt: unknown): { lon: number; lat: number } | null {
  if (typeof wkt !== "string") return null;
  const m = /POINT\s*[ZM]*\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(wkt);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

function parsePolygon(geometry: Json): Ring[] | null {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;
  const g = geometry as { type?: string; coordinates?: Json };
  if (g.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  return (g.coordinates as Json[][]).map((ring) =>
    ring
      .map((pt) => {
        const arr = Array.isArray(pt) ? pt : [];
        const x = Number(arr[0] ?? 0);
        const y = Number(arr[1] ?? 0);
        return Number.isFinite(x) && Number.isFinite(y) ? ([x, y] as Point2) : null;
      })
      .filter((p): p is Point2 => p !== null),
  );
}

function parseLineString(geometry: Json): Ring | null {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;
  const g = geometry as { type?: string; coordinates?: Json };
  if (g.type !== "LineString" || !Array.isArray(g.coordinates)) return null;
  return (g.coordinates as Json[])
    .map((pt) => {
      const arr = Array.isArray(pt) ? pt : [];
      const x = Number(arr[0] ?? 0);
      const y = Number(arr[1] ?? 0);
      return Number.isFinite(x) && Number.isFinite(y) ? ([x, y] as Point2) : null;
    })
    .filter((p): p is Point2 => p !== null);
}

function triangulateFan(ring: Ring): number[] {
  // Fan triangulation from the first vertex. Room footprints are typically
  // simple polygons, so this is sufficient for preview geometry.
  const indices: number[] = [];
  for (let i = 1; i < ring.length - 1; i++) {
    indices.push(0, i, i + 1);
  }
  return indices;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  if (clean.length !== 3 && clean.length !== 6) return [0.8, 0.8, 0.8];
  const expand =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = Number.parseInt(expand.slice(0, 2), 16) / 255;
  const g = Number.parseInt(expand.slice(2, 4), 16) / 255;
  const b = Number.parseInt(expand.slice(4, 6), 16) / 255;
  if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
    return [r, g, b] as [number, number, number];
  }
  return [0.8, 0.8, 0.8];
}

function materialRoughness(absorption: number | null): number {
  // Higher absorption -> rougher / less reflective surface.
  const a = absorption ?? 0.5;
  return Math.max(0.05, Math.min(0.95, a));
}

interface MaterialDef {
  name: string;
  color: [number, number, number];
  roughness: number;
  metallic: number;
}

function buildMaterial(
  name: string,
  colorHex: string | null,
  absorption: number | null,
): MaterialDef {
  const color: [number, number, number] = colorHex ? hexToRgb(colorHex) : [0.8, 0.8, 0.8];
  return { name, color, roughness: materialRoughness(absorption), metallic: 0 };
}

function materialBlock(m: MaterialDef): string {
  const lines = [
    `    def Material "${m.name}"`,
    `    {`,
    `        token outputs:surface.connect = </Root/Materials/${m.name}/PreviewSurface.outputs:surface>`,
    ``,
    `        def Shader "PreviewSurface"`,
    `        {`,
    `            uniform token info:id = "UsdPreviewSurface"`,
    `            color3f inputs:diffuseColor = ${usdColor3f(...m.color)}`,
    `            float inputs:roughness = ${usdFloat(m.roughness)}`,
    `            float inputs:metallic = ${usdFloat(m.metallic)}`,
    `            token outputs:surface`,
    `        }`,
    `    }`,
  ];
  return lines.join("\n");
}

function meshBlock(
  name: string,
  points: string[],
  indices: number[],
  counts: number[],
  material: string | null,
  displayColor?: [number, number, number],
): string {
  const color = displayColor
    ? `            color3f[] primvars:displayColor = [${usdColor3f(...displayColor)}]`
    : "";
  const bind = material
    ? `            rel material:binding = </Root/Materials/${material}> ()`
    : "";
  const lines = [
    `        def Mesh "${name}"`,
    `        {`,
    `            int[] faceVertexCounts = ${usdArray(counts, String)}`,
    `            int[] faceVertexIndices = ${usdArray(indices, String)}`,
    `            point3f[] points = ${usdArray(points, (p) => p)}`,
    `            token orientation = "leftHanded"`,
    color ? color : "",
    bind ? bind : "",
    `        }`,
  ];
  return lines.filter(Boolean).join("\n");
}

function cubeBlock(
  name: string,
  size: [number, number, number],
  translate: [number, number, number],
  rotateY: number,
  material: string | null,
): string {
  const [sx, sy, sz] = size;
  const [tx, ty, tz] = translate;
  const lines = [
    `        def Cube "${name}"`,
    `        {`,
    `            double3 xformOp:translate = ${usdPoint3f(tx, ty, tz)}`,
    `            double xformOp:rotateY = ${usdFloat(rotateY)}`,
    `            double3 xformOp:scale = ${usdPoint3f(sx, sy, sz)}`,
    `            uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateY", "xformOp:scale"]`,
    material ? `            rel material:binding = </Root/Materials/${material}> ()` : "",
    `        }`,
  ];
  return lines.filter(Boolean).join("\n");
}

function edgeAngle(start: Point2, end: Point2): number {
  return (Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI;
}

function edgeMidpoint(start: Point2, end: Point2): Point2 {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function edgeLength(start: Point2, end: Point2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function buildRoomShell(
  footprint: Ring,
  height: number,
  floorMat: MaterialDef,
  wallMat: MaterialDef,
  ceilingMat: MaterialDef,
): { blocks: string[]; primCount: number } {
  const blocks: string[] = [];
  let primCount = 0;

  // Floor mesh
  const floorPoints = footprint.map(([x, y]) => usdPoint3f(x, 0, y));
  const floorIndices = triangulateFan(footprint);
  const floorCounts = new Array(floorIndices.length / 3).fill(3);
  blocks.push(
    meshBlock("Floor", floorPoints, floorIndices, floorCounts, floorMat.name, floorMat.color),
  );
  primCount++;

  // Ceiling mesh
  const ceilPoints = footprint.map(([x, y]) => usdPoint3f(x, height, y));
  const ceilIndices = triangulateFan(footprint);
  const ceilCounts = new Array(ceilIndices.length / 3).fill(3);
  blocks.push(
    meshBlock("Ceiling", ceilPoints, ceilIndices, ceilCounts, ceilingMat.name, ceilingMat.color),
  );
  primCount++;

  // Walls
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % footprint.length]!;
    const points = [
      usdPoint3f(a[0], 0, a[1]),
      usdPoint3f(b[0], 0, b[1]),
      usdPoint3f(b[0], height, b[1]),
      usdPoint3f(a[0], height, a[1]),
    ];
    const indices = [0, 1, 2, 0, 2, 3];
    const counts = [3, 3];
    blocks.push(meshBlock(`Wall_${i}`, points, indices, counts, wallMat.name, wallMat.color));
    primCount++;
  }

  return { blocks, primCount };
}

function buildOpening(
  f: Feature,
  wallHeight: number,
  index: number,
  mat: MaterialDef,
): { block: string; isWindow: boolean } | null {
  const line = parseLineString(f.geometry);
  if (!line || line.length < 2) return null;
  const start = line[0]!;
  const end = line[1]!;

  const props = f.properties;
  const kind = String(props?.["kind"] ?? "door").toLowerCase();
  const isWindow = kind.includes("window");
  const width = num(props?.["width_m"]) ?? edgeLength(start, end);
  const height = num(props?.["height_m"]) ?? (isWindow ? wallHeight * 0.4 : wallHeight * 0.85);
  const midpoint = edgeMidpoint(start, end);
  const angle = edgeAngle(start, end);

  const name = sanitize(`${kind}_${index}`);
  const size: [number, number, number] = isWindow ? [width, height, 0.02] : [width, height, 0.05];
  const translate: [number, number, number] = [midpoint[0], height / 2, midpoint[1]];

  const block = cubeBlock(name, size, translate, angle, mat.name);
  return { block, isWindow };
}

function buildObject(f: Feature, index: number): string | null {
  const props = f.properties;
  const width = num(props?.["width_m"]);
  const depth = num(props?.["depth_m"]);
  const height = num(props?.["height_m"]);
  const x = num(props?.["x_m"]);
  const y = num(props?.["y_m"]);
  const attributes =
    props?.["attributes"] && typeof props["attributes"] === "object"
      ? (props["attributes"] as Record<string, Json>)
      : {};
  const yaw = num(props?.["yaw_deg"]) ?? num(attributes["yaw_deg"]) ?? 0;

  if (width == null || depth == null || height == null) {
    // Try to derive from footprint polygon bounding box.
    const poly = parsePolygon(f.geometry);
    const ring = poly?.[0];
    if (!ring || ring.length < 3) return null;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const d = maxY - minY;
    const h = height ?? Math.min(w, d) ?? 0.8;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const label = sanitize(String(props?.["label"] ?? `object_${index}`));
    const color = str(props?.["color_hex"]);
    const mat = buildMaterial(`${label}_mat`, color, num(props?.["absorption"]));
    return cubeBlock(label, [w, h, d], [cx, h / 2, cy], 0, mat.name);
  }

  if (x == null || y == null) return null;
  const label = sanitize(String(props?.["label"] ?? `object_${index}`));
  const color = str(props?.["color_hex"]);
  const mat = buildMaterial(`${label}_mat`, color, num(props?.["absorption"]));
  return cubeBlock(label, [width, height, depth], [x, height / 2, y], yaw, mat.name);
}

function customDataBlock(data: Record<string, Json>): string {
  const entries = Object.entries(data)
    .map(([k, v]) => {
      if (v === null) return `            ${EXT}:${k} = None`;
      if (typeof v === "string") return `            ${EXT}:${k} = ${usdString(v)}`;
      if (typeof v === "number") return `            ${EXT}:${k} = ${usdFloat(v)}`;
      if (typeof v === "boolean") return `            ${EXT}:${k} = ${v}`;
      return `            ${EXT}:${k} = ${json(v)}`;
    })
    .join("\n");
  if (!entries) return "";
  return ["        customData = {", entries, "        }"].join("\n");
}

/** Builds the OpenUSD archive from a scan_export payload. */
export function buildUsd(payload: {
  geojson: { [key: string]: Json };
  postgis: { [key: string]: Json };
  layers: Json[];
}): UsdArchive {
  const features = ((payload.geojson?.["features"] as Feature[] | undefined) ?? []).filter(
    (f) => f && typeof f === "object",
  );
  const scanRow =
    ((payload.postgis?.["scans"] as Record<string, Json>[] | undefined) ?? [])[0] ?? {};

  const scanId = String(scanRow["id"] ?? "scan");
  const scanName = String(scanRow["name"] ?? "Space");
  const height = num(scanRow["height_m"]) ?? 2.7;
  const origin = parsePoint(scanRow["site_location"]);
  const northOffset = num(scanRow["north_offset_deg"]) ?? 0;

  const by = (entity: string) =>
    features.filter((f) => String(f.properties?.["entity"] ?? "") === entity);

  const room = by("room_footprint")[0];
  const footprint = room?.geometry ? (parsePolygon(room.geometry)?.[0] ?? null) : null;
  const hasShell = footprint !== null && footprint.length >= 3;

  const surfaces = by("surface");
  const surfaceByKind = (kind: string) =>
    surfaces.find((s) =>
      String(s.properties?.["kind"] ?? "")
        .toLowerCase()
        .includes(kind),
    );

  const floorSurface = surfaceByKind("floor");
  const wallSurface = surfaceByKind("wall");
  const ceilingSurface = surfaceByKind("ceiling");

  const floorMat = buildMaterial(
    "floor_mat",
    str(floorSurface?.properties?.["color_hex"]),
    num(floorSurface?.properties?.["absorption"]),
  );
  const wallMat = buildMaterial(
    "wall_mat",
    str(wallSurface?.properties?.["color_hex"]),
    num(wallSurface?.properties?.["absorption"]),
  );
  const ceilingMat = buildMaterial(
    "ceiling_mat",
    str(ceilingSurface?.properties?.["color_hex"]),
    num(ceilingSurface?.properties?.["absorption"]),
  );
  const windowMat: MaterialDef = {
    name: "window_mat",
    color: [0.7, 0.85, 0.95],
    roughness: 0.05,
    metallic: 0,
  };
  const doorMat: MaterialDef = {
    name: "door_mat",
    color: [0.55, 0.4, 0.25],
    roughness: 0.6,
    metallic: 0,
  };

  const materials = [floorMat, wallMat, ceilingMat, windowMat, doorMat];

  const lines: string[] = [
    "#usda 1.0",
    "(",
    '    defaultPrim = "Root"',
    "    metersPerUnit = 1.0",
    '    upAxis = "Y"',
    '    doc = "Generated by SQNR"',
    ")",
    "",
    'def Xform "Root"',
    "{",
    customDataBlock({
      scan_id: scanId,
      name: scanName,
      lod_level: scanRow["lod_level"] ?? null,
      width_m: scanRow["width_m"] ?? null,
      length_m: scanRow["length_m"] ?? null,
      height_m: scanRow["height_m"] ?? null,
      floor_area_m2: scanRow["floor_area_m2"] ?? null,
      volume_m3: scanRow["volume_m3"] ?? null,
      georeferenced: origin !== null,
      origin_lat: origin?.lat ?? null,
      origin_lon: origin?.lon ?? null,
      north_offset_deg: northOffset,
      acoustics: (scanRow["acoustics"] ?? null) as Json,
    }),
    "",
    '    def Scope "Materials"',
    "    {",
  ];

  for (const m of materials) {
    lines.push(materialBlock(m));
  }
  lines.push("    }");

  let shellPrims = 0;
  let openingPrims = 0;
  let objectPrims = 0;

  if (hasShell && footprint) {
    lines.push("");
    lines.push('    def Scope "Shell"');
    lines.push("    {");
    const shell = buildRoomShell(footprint, height, floorMat, wallMat, ceilingMat);
    lines.push(...shell.blocks);
    shellPrims = shell.primCount;

    const openings = by("portal");
    if (openings.length > 0) {
      lines.push("");
      lines.push('        def Scope "Openings"');
      lines.push("        {");
      openings.forEach((p, i) => {
        const built = buildOpening(
          p,
          height,
          i,
          p.properties?.["kind"] === "window" ? windowMat : doorMat,
        );
        if (built) {
          lines.push(built.block);
          openingPrims++;
        }
      });
      lines.push("        }");
    }
    lines.push("    }");
  }

  const objects = by("object");
  if (objects.length > 0) {
    lines.push("");
    lines.push('    def Scope "Objects"');
    lines.push("    {");
    objects.forEach((o, i) => {
      const block = buildObject(o, i);
      if (block) {
        lines.push(block);
        objectPrims++;
      }
    });
    lines.push("    }");
  }

  lines.push("}");

  return {
    usda: lines.join("\n"),
    prims: {
      shell: shellPrims,
      objects: objectPrims,
      openings: openingPrims,
      materials: materials.length,
    },
    hasShell,
  };
}
