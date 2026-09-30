// The rows an analysis writes: objects, surfaces, portals, the L4 navigation
// graph, frame poses and the L0–L5 layer registry. Ported from the persistence
// half of `analyzeScan`; geometry is WKT, converted by PostGIS on insert.
// Portal and node ids are generated here, so the navigation graph no longer
// needs a round trip per insert and everything is written in one transaction.
import { randomUUID } from "node:crypto";
import * as geo from "@spatial/domain/scan-spatial";
import { num } from "./plan-geometry";
import type { AnalysisPhoto, AnalysisResult } from "./types";

type AnalysisObject = AnalysisResult["objects"][number];

export interface ObjectRow {
  label: string;
  category: string;
  confidence: number | null;
  x_m: number | null;
  y_m: number | null;
  width_m: number | null;
  depth_m: number | null;
  height_m: number | null;
  footprint: string;
  centroid: string;
  attributes: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SurfaceRow {
  name: string;
  kind: string;
  material: string;
  area_m2: number | null;
  absorption: number | null;
  reflectivity: number | null;
  color_hex: string;
  notes: string | null;
  plane: string;
  band_absorption: Record<string, number>;
}

export interface PortalRow {
  id: string;
  kind: string;
  wall: string;
  offset_m: number;
  width_m: number;
  height_m: number;
  sill_m: number;
  confidence: number | null;
  notes: string | null;
  line: string;
  attributes: Record<string, unknown>;
}

export interface NavNodeRow {
  id: string;
  kind: string;
  label: string;
  point: string;
  portal_id: string | null;
  metadata: Record<string, unknown>;
}

export interface NavEdgeRow {
  from_node: string;
  to_node: string;
  path: string | null;
  cost_m: number | null;
  traversable: boolean;
}

export interface FramePoseRow {
  storage_path: string;
  camera_pose: string;
  view_cone: string;
}

export interface Dims {
  width: number;
  length: number;
  height: number;
}

export function objectRows(
  result: AnalysisResult,
  catalogRefs: Map<AnalysisObject, string>,
): ObjectRow[] {
  return (result.objects ?? []).map((o) => {
    const details = {
      material: o.material ?? null,
      against_wall: o.against_wall ?? null,
      yaw_deg: num(o.yaw_deg, null),
      wall_offset_m: num(o.wall_offset_m, null),
      supporting_headings_deg: Array.isArray(o.supporting_headings_deg)
        ? o.supporting_headings_deg
        : [],
      floor_elevation_m: num(o.floor_elevation_m, 0),
      relative_to: o.relative_to ?? null,
      spatial_relation: o.spatial_relation ?? "none",
      catalog_ref: catalogRefs.get(o) ?? null,
    };
    return {
      label: String(o.label ?? "object"),
      category: String(o.category ?? "other"),
      confidence: num(o.confidence, 0.5),
      x_m: num(o.x_m, 0),
      y_m: num(o.y_m, 0),
      width_m: num(o.width_m, 0.5),
      depth_m: num(o.depth_m, 0.5),
      height_m: num(o.height_m, 0.5),
      footprint: geo.rotatedRectWkt(
        num(o.x_m, 0),
        num(o.y_m, 0),
        num(o.width_m, 0.5),
        num(o.depth_m, 0.5),
        num(o.yaw_deg, 0),
      ),
      centroid: geo.pointZWkt(num(o.x_m, 0), num(o.y_m, 0), (num(o.height_m, 0.5) ?? 0.5) / 2),
      attributes: details,
      metadata: { ...details },
    };
  });
}

export function surfaceRows(result: AnalysisResult, dims: Dims): SurfaceRow[] {
  const { width, length, height } = dims;
  const makeSurface = (s: {
    name?: unknown;
    kind?: unknown;
    material?: unknown;
    area_m2?: unknown;
    absorption?: unknown;
    reflectivity?: unknown;
    color_hex?: unknown;
    notes?: unknown;
    band_absorption?: unknown;
  }): SurfaceRow => ({
    name: String(s.name ?? "surface"),
    kind: String(s.kind ?? "wall"),
    material: String(s.material ?? "unknown"),
    area_m2: num(s.area_m2),
    absorption: num(s.absorption),
    reflectivity: num(s.reflectivity),
    color_hex: typeof s.color_hex === "string" ? s.color_hex : "#8a8f98",
    notes: typeof s.notes === "string" ? s.notes : null,
    plane: geo.surfacePlane(String(s.kind ?? "wall"), String(s.name ?? "surface"), width, length),
    band_absorption: JSON.parse(JSON.stringify(s.band_absorption ?? {})) as Record<string, number>,
  });

  const surfaces: SurfaceRow[] = (result.surfaces ?? []).slice(0, 40).map(makeSurface);

  // The shell of a room always exists, so never leave the L3 layer empty just
  // because the vision pass forgot to enumerate it. Anything missing is
  // synthesised deterministically from the reconstructed dimensions.
  const has = (re: RegExp) => surfaces.some((s) => re.test(`${s.kind} ${s.name}`.toLowerCase()));
  const shell = [
    { name: "Floor", kind: "floor", area: width * length, abs: 0.1, mat: "unknown" },
    { name: "Ceiling", kind: "ceiling", area: width * length, abs: 0.08, mat: "painted plaster" },
    { name: "North wall", kind: "wall", area: width * height, abs: 0.06, mat: "painted plaster" },
    { name: "South wall", kind: "wall", area: width * height, abs: 0.06, mat: "painted plaster" },
    { name: "East wall", kind: "wall", area: length * height, abs: 0.06, mat: "painted plaster" },
    { name: "West wall", kind: "wall", area: length * height, abs: 0.06, mat: "painted plaster" },
  ];
  for (const part of shell) {
    const key = part.name.split(" ")[0]!.toLowerCase();
    const re = new RegExp(part.kind === "wall" ? key : part.kind);
    if (has(re)) continue;
    surfaces.push(
      makeSurface({
        name: part.name,
        kind: part.kind,
        material: part.mat,
        area_m2: part.area,
        absorption: part.abs,
        reflectivity: 1 - part.abs,
        color_hex: "#8a8f98",
        notes: "Derived from reconstructed room dimensions (not directly classified).",
      }),
    );
  }

  // Soft treatments detected as objects (rugs, carpets, curtains, acoustic
  // panels) are acoustically significant surfaces too — carry them across so
  // a woven rug shows up in the surface list, not only in the object list.
  for (const o of result.objects ?? []) {
    const label = `${o.label ?? ""} ${o.category ?? ""}`.toLowerCase();
    if (!/rug|carpet|curtain|drape|acoustic panel|tapestry/.test(label)) continue;
    const name = String(o.label ?? "treatment");
    if (surfaces.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
    const soft = /curtain|drape/.test(label);
    surfaces.push(
      makeSurface({
        name,
        kind: soft ? "curtain" : "rug",
        material: o.material ?? (soft ? "fabric" : "woven textile"),
        area_m2: (num(o.width_m, 1) ?? 1) * (num(soft ? o.height_m : o.depth_m, 1) ?? 1),
        absorption: soft ? 0.5 : 0.35,
        reflectivity: soft ? 0.5 : 0.65,
        color_hex: "#c08a5a",
        notes: "Soft treatment carried over from object detection.",
      }),
    );
  }
  return surfaces;
}

export function portalRows(result: AnalysisResult, dims: Dims): PortalRow[] {
  const { width, length, height } = dims;
  const rawPortals = (result.portals ?? []).slice(0, 20).flatMap((p): PortalRow[] => {
    const candidateWall = String(p.wall ?? "").toLowerCase();
    if (!["north", "east", "south", "west"].includes(candidateWall)) return [];
    const wall = candidateWall;
    const kind = String(p.kind ?? "door");
    const openSide = /open_side|open side/i.test(kind);
    const isWindow = /window|glaz/i.test(kind);
    // Clamp each opening onto its wall so nothing hangs off the end of the
    // plan: width can never exceed the wall run, and the offset is pinned to
    // [0, run - width]. An "open side" is the whole wall by definition.
    const run = wall === "north" || wall === "south" ? width : length;
    const wantedW = openSide ? run : (num(p.width_m, 0.9) ?? 0.9);
    const pw = Math.min(Math.max(wantedW, 0.2), Math.max(run, 0.2));
    const off = openSide
      ? 0
      : Math.min(Math.max(num(p.offset_m, 0) ?? 0, 0), Math.max(run - pw, 0));
    // Head and sill: a door or open threshold stands on the floor, a window
    // sits on its measured sill, and nothing is allowed through the ceiling.
    const wantedH = openSide ? height : (num(p.height_m, isWindow ? 1.3 : 2.03) ?? 2.03);
    const ph = Math.min(Math.max(wantedH, 0.2), height);
    const reportedSill = num(p.sill_m, null);
    const wantedSill =
      openSide || /door|archway|opening|pass/i.test(kind)
        ? 0
        : (reportedSill ?? (isWindow ? 0.9 : 0));
    const sill = Math.min(Math.max(wantedSill, 0), Math.max(height - ph - 0.02, 0));
    const clamped =
      Math.abs((num(p.offset_m, 0) ?? 0) - off) > 0.02 ||
      Math.abs(wantedW - pw) > 0.02 ||
      Math.abs(wantedH - ph) > 0.02;
    return [
      {
        id: randomUUID(),
        kind,
        wall,
        offset_m: off,
        width_m: pw,
        height_m: ph,
        sill_m: sill,
        confidence: num(p.confidence, 0.5),
        notes: p.notes ?? null,
        line: geo.portalLine(wall, off, pw, width, length),
        attributes: {
          open_side: openSide,
          sill_reported: reportedSill != null,
          clamped_to_wall: clamped,
          wall_run_m: Math.round(run * 1000) / 1000,
        },
      },
    ];
  });

  // Two openings must never occupy the same stretch of wall. Keep the more
  // confident one and drop the duplicate rather than drawing them on top of
  // one another.
  const portals: PortalRow[] = [];
  for (const p of [...rawPortals].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    const overlaps = portals.some(
      (q) =>
        q.wall === p.wall &&
        p.offset_m < q.offset_m + q.width_m - 0.05 &&
        q.offset_m < p.offset_m + p.width_m - 0.05,
    );
    if (!overlaps) portals.push(p);
  }
  return portals;
}

/** L4 navigation graph: the room center plus one node inside each portal. */
export function navigationGraph(
  portals: PortalRow[],
  dims: Dims,
): { nodes: NavNodeRow[]; edges: NavEdgeRow[] } {
  const center: NavNodeRow = {
    id: randomUUID(),
    kind: "center",
    label: "Room center",
    point: geo.pointZWkt(0, 0, 0),
    portal_id: null,
    metadata: {},
  };
  const nodes: NavNodeRow[] = [center];
  const edges: NavEdgeRow[] = [];
  for (const p of portals) {
    const pt = geo.portalNodePoint(p.wall, p.offset_m, p.width_m, dims.width, dims.length);
    const node: NavNodeRow = {
      id: randomUUID(),
      kind: "portal",
      label: `Portal ${p.wall}`,
      point: geo.pointZWkt(pt[0], pt[1], pt[2]),
      portal_id: p.id,
      metadata: { wall: p.wall },
    };
    nodes.push(node);
    edges.push({
      from_node: center.id,
      to_node: node.id,
      path: geo.lineZWkt([0, 0, 0], pt),
      cost_m: Math.round(Math.hypot(pt[0], pt[1]) * 100) / 100,
      traversable: true,
    });
  }
  return { nodes, edges };
}

/** Frame poses / view cones (L0–L1), drawn at each lens' real field of view. */
export function framePoseRows(posed: AnalysisPhoto[]): FramePoseRow[] {
  return posed.map((p) => {
    const fg = geo.frameGeometry(p.heading_deg, p.pose, 3.5, p.fov_deg ?? 62);
    return { storage_path: p.path, camera_pose: fg.pose, view_cone: fg.cone };
  });
}
