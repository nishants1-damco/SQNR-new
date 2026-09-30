/**
 * L0–L5 spatial persistence helpers.
 *
 * Local room CRS (SRID 0): origin at the room center, +X east/right,
 * +Y north/forward, +Z up. Real-world siting lives on scans.site_location
 * (geography 4326).
 */

type Num = number | null | undefined;

const n = (v: Num, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function rectWkt(cx: Num, cy: Num, w: Num, d: Num) {
  const x = n(cx);
  const y = n(cy);
  const hw = Math.max(n(w, 0.2), 0.05) / 2;
  const hd = Math.max(n(d, 0.2), 0.05) / 2;
  const pts = [
    [x - hw, y - hd],
    [x + hw, y - hd],
    [x + hw, y + hd],
    [x - hw, y + hd],
    [x - hw, y - hd],
  ];
  return `POLYGON((${pts.map(([px, py]) => `${px!.toFixed(3)} ${py!.toFixed(3)}`).join(",")}))`;
}

export function rotatedRectWkt(cx: Num, cy: Num, w: Num, d: Num, yawDeg: Num) {
  const x = n(cx);
  const y = n(cy);
  const hw = Math.max(n(w, 0.2), 0.05) / 2;
  const hd = Math.max(n(d, 0.2), 0.05) / 2;
  const angle = (n(yawDeg) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: Array<[number, number]> = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  const pts: Array<[number, number]> = corners.map(([lx, ly]) => [
    x + lx * cos - ly * sin,
    y + lx * sin + ly * cos,
  ]);
  pts.push(pts[0] as [number, number]);
  return `POLYGON((${pts.map((point) => `${point[0].toFixed(3)} ${point[1].toFixed(3)}`).join(",")}))`;
}

export function pointZWkt(x: Num, y: Num, z: Num) {
  return `POINTZ(${n(x).toFixed(3)} ${n(y).toFixed(3)} ${n(z).toFixed(3)})`;
}

export function lineWkt(x1: Num, y1: Num, x2: Num, y2: Num) {
  return `LINESTRING(${n(x1).toFixed(3)} ${n(y1).toFixed(3)},${n(x2).toFixed(3)} ${n(y2).toFixed(3)})`;
}

export function lineZWkt(a: [number, number, number], b: [number, number, number]) {
  return `LINESTRINGZ(${a.map((v) => v.toFixed(3)).join(" ")},${b.map((v) => v.toFixed(3)).join(" ")})`;
}

/** Wall-relative portal placement → local-CRS line segment. */
export function portalLine(wall: string, offset: Num, width: Num, roomW: number, roomL: number) {
  const off = n(offset);
  const w = Math.max(n(width, 0.9), 0.1);
  // Convention: +y is compass north, so the north wall is at y = +roomL/2.
  // Offsets run left-to-right as seen from inside the room: west->east on the
  // north/south walls, south->north on the east/west walls.
  switch (wall) {
    case "north":
      return lineWkt(-roomW / 2 + off, roomL / 2, -roomW / 2 + off + w, roomL / 2);
    case "south":
      return lineWkt(-roomW / 2 + off, -roomL / 2, -roomW / 2 + off + w, -roomL / 2);
    case "east":
      return lineWkt(roomW / 2, -roomL / 2 + off, roomW / 2, -roomL / 2 + off + w);
    default:
      return lineWkt(-roomW / 2, -roomL / 2 + off, -roomW / 2, -roomL / 2 + off + w);
  }
}

/** Point just inside the room from a portal, used as an L4 nav node. */
export function portalNodePoint(
  wall: string,
  offset: Num,
  width: Num,
  roomW: number,
  roomL: number,
) {
  const off = n(offset) + Math.max(n(width, 0.9), 0.1) / 2;
  const inset = 0.6;
  switch (wall) {
    case "north":
      return [-roomW / 2 + off, roomL / 2 - inset, 0] as [number, number, number];
    case "south":
      return [-roomW / 2 + off, -roomL / 2 + inset, 0] as [number, number, number];
    case "east":
      return [roomW / 2 - inset, -roomL / 2 + off, 0] as [number, number, number];
    default:
      return [-roomW / 2 + inset, -roomL / 2 + off, 0] as [number, number, number];
  }
}

/** Camera pose + view cone for a captured frame (L0/L1). */
export function frameGeometry(
  headingDeg: Num,
  station?: { x?: Num; y?: Num; z?: Num } | null,
  reach = 3.5,
  fovDeg = 62,
) {
  const h = ((n(headingDeg) % 360) + 360) % 360;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dir = rad(h);
  const half = rad(fovDeg / 2);
  // Station comes from the on-device inertial track (origin = first frame),
  // so view cones fan out from where the phone actually stood.
  const ox = n(station?.x);
  const oy = n(station?.y);
  const oz = n(station?.z);
  const p = (a: number) => [ox + Math.sin(a) * reach, oy + Math.cos(a) * reach];
  const a = p(dir - half);
  const b = p(dir);
  const c = p(dir + half);
  const ring = [[ox, oy], a, b, c, [ox, oy]] as number[][];
  return {
    pose: pointZWkt(ox, oy, 1.5 + oz),
    cone: `POLYGON((${ring
      .map((pt) => `${(pt[0] ?? 0).toFixed(3)} ${(pt[1] ?? 0).toFixed(3)}`)
      .join(",")}))`,
  };
}

export const roomFootprint = (w: number, l: number) => rectWkt(0, 0, w, l);

/**
 * Plan geometry for a surface. Floors and ceilings are the room footprint;
 * each wall is a thin polygon in plan. scan_surfaces.plane is Polygon-typed,
 * so lines are invalid even though they look natural for walls.
 */
export function surfacePlane(kind: string, name: string, w: number, l: number) {
  const text = `${kind} ${name}`.toLowerCase();
  if (/floor|ceiling|soffit|roof|rug|carpet/.test(text)) return roomFootprint(w, l);
  const wall = /north/.test(text)
    ? "north"
    : /south/.test(text)
      ? "south"
      : /east/.test(text)
        ? "east"
        : /west/.test(text)
          ? "west"
          : null;
  if (!wall) return roomFootprint(w, l);
  const t = 0.02;
  switch (wall) {
    case "north":
      return rectWkt(0, l / 2 - t / 2, w, t);
    case "south":
      return rectWkt(0, -l / 2 + t / 2, w, t);
    case "east":
      return rectWkt(w / 2 - t / 2, 0, t, l);
    default:
      return rectWkt(-w / 2 + t / 2, 0, t, l);
  }
}

/**
 * Canonical L0–L5 layer definitions written to public.scan_layers.
 *
 * Root ontology — each level is a tier of the spatial model, and every level
 * assumes the ones below it:
 *   L0 identity    — the room exists: name, inventory of what is in it
 *   L1 planar      — 2D: floor plan, surfaces and portals in plan, 2D nav
 *   L2 volumetric  — 3D: heights, volume, occlusion, 3D navigation
 *   L3 physical    — surfaces, objects, materials, physics properties
 *   L4 fields      — sound, light, temperature, occupancy, line of sight
 *   L5 simulation  — hypothetical states derived by manipulating L0–L4
 */
export const SPATIAL_ONTOLOGY = {
  version: "1.0",
  name: "room-spatial-tiering",
  levels: {
    0: { key: "identity", title: "Identity & inventory" },
    1: { key: "planar", title: "2D plan, surfaces, portals, navigation" },
    2: { key: "volumetric", title: "3D extent, volume, occlusion, navigation" },
    3: { key: "physical", title: "Surfaces, objects, materials, physics" },
    4: { key: "fields", title: "Sound, light, thermal, occupancy, line of sight" },
    5: { key: "simulation", title: "Hypothetical states derived from L0–L4" },
  },
} as const;

export function buildLayers(input: {
  scanId: string;
  userId: string;
  photos: unknown[];
  acoustics: Record<string, unknown> | null;
  depthSource: string | null;
  dims: { width: number; length: number; height: number };
  objects: unknown[];
  surfaces: unknown[];
  portals: unknown[];
  navNodes: number;
  navEdges: number;
  summary: string | null;
  model: string;
  roomName?: string | null;
}) {
  const base = { scan_id: input.scanId, user_id: input.userId };
  const area = input.dims.width * input.dims.length;
  const volume = area * input.dims.height;
  const ont = (level: 0 | 1 | 2 | 3 | 4 | 5) => ({
    ontology: SPATIAL_ONTOLOGY.name,
    ontology_version: SPATIAL_ONTOLOGY.version,
    level_key: SPATIAL_ONTOLOGY.levels[level].key,
    level_title: SPATIAL_ONTOLOGY.levels[level].title,
  });

  return [
    {
      ...base,
      level: 0,
      name: "identity",
      producer: "browser-capture",
      quality: input.photos.length >= 8 ? 1 : input.photos.length / 8,
      payload: {
        ...ont(0),
        room_name: input.roomName ?? null,
        inventory_count: input.objects.length,
        frames: input.photos.length,
        depth_source: input.depthSource,
        audio_probe: !!input.acoustics,
        chirps: input.acoustics?.["chirps"] ?? 0,
        crs: "local-room (SRID 0), origin at room center, +Y north, meters",
      },
    },
    {
      ...base,
      level: 1,
      name: "planar",
      producer: "plan-projection",
      quality: input.dims.width > 0 && input.dims.length > 0 ? 0.8 : 0,
      payload: {
        ...ont(1),
        width_m: input.dims.width,
        length_m: input.dims.length,
        floor_area_m2: Math.round(area * 100) / 100,
        portals: input.portals.length,
        wall_surfaces: input.surfaces.length,
        nav_nodes_2d: input.navNodes,
        nav_edges_2d: input.navEdges,
      },
    },
    {
      ...base,
      level: 2,
      name: "volumetric",
      producer: input.depthSource ? `depth:${input.depthSource}` : "vision-estimate",
      quality: input.depthSource ? 0.9 : 0.6,
      payload: {
        ...ont(2),
        ...input.dims,
        volume_m3: Math.round(volume * 100) / 100,
        occluders: input.objects.length,
        nav_nodes_3d: input.navNodes,
      },
    },
    {
      ...base,
      level: 3,
      name: "physical",
      producer: input.model,
      quality: 0.75,
      payload: {
        ...ont(3),
        objects: input.objects.length,
        surfaces: input.surfaces.length,
        portals: input.portals.length,
      },
    },
    {
      ...base,
      level: 4,
      name: "fields",
      producer: "web-audio-probe + device-orientation",
      quality: input.acoustics ? 0.8 : 0.2,
      payload: {
        ...ont(4),
        acoustics: input.acoustics ?? {},
        rt60_s: input.acoustics?.["rt60_s"] ?? null,
        first_reflection_ms: input.acoustics?.["first_reflection_ms"] ?? null,
        reflection_distance_m: input.acoustics?.["reflection_distance_m"] ?? null,
        light: null,
        thermal: null,
        occupancy: null,
      },
    },
    {
      ...base,
      level: 5,
      name: "simulation",
      producer: input.model,
      quality: input.summary ? 0.6 : 0,
      payload: {
        ...ont(5),
        summary: input.summary,
        baseline_acoustic_character: input.acoustics?.["hardness"] ?? null,
        baseline_rt60_s: input.acoustics?.["rt60_s"] ?? null,
        scenarios: [],
      },
    },
  ];
}
