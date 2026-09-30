/**
 * Single source of truth for turning stored scan records into render-ready
 * geometry. Both the 3D viewer and the point cloud consume this, so the two
 * views are guaranteed to agree: same origin (room center), same wall planes,
 * same portal sills, same object clamping.
 */

export interface RawObject {
  id?: string;
  /** Wall the object's back is against, when the reconstruction declared one. */
  against_wall?: string | null;
  /** Persisted form of the same hint (scan_objects.attributes jsonb). */
  attributes?: unknown;
  label?: string;
  category?: string | null;
  x_m?: number | null;
  y_m?: number | null;
  width_m?: number | null;
  depth_m?: number | null;
  height_m?: number | null;
  /** Degrees clockwise from compass north, persisted in attributes when not top-level. */
  yaw_deg?: number | null;
}

export interface RawPortal {
  id?: string;
  kind?: string;
  wall?: string;
  offset_m?: number | null;
  width_m?: number | null;
  height_m?: number | null;
  /** Height of the opening's bottom edge above the floor, when measured. */
  sill_m?: number | null;
}

export type WallKey = "north" | "east" | "south" | "west";

export interface PlacedObject {
  id: string;
  label: string;
  category: string;
  /** Room-center coordinates: +x east, +z south (three.js z), y up. */
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Bottom elevation above the floor. */
  bottom: number;
  /** Rotation around the vertical axis in the Three.js/SVG plan frame. */
  yawRad: number;
  yawDeg: number;
}

export interface PlacedPortal {
  id: string;
  kind: string;
  wall: WallKey;
  isWindow: boolean;
  /** Distance along the wall run to the near edge of the opening. */
  offset: number;
  w: number;
  h: number;
  /** Height of the opening's bottom edge above the floor. */
  sill: number;
  /** Center of the opening in room-center coordinates. */
  x: number;
  z: number;
  /** Vertical center of the opening. */
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const n = (v: unknown, fallback: number) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/** Reads an against_wall hint out of a loosely-typed jsonb attributes blob. */
export function attrWall(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const v = (attributes as Record<string, unknown>)["against_wall"];
  return typeof v === "string" ? v : null;
}

export function attrYaw(attributes: unknown): number | null {
  if (!attributes || typeof attributes !== "object") return null;
  const value = Number((attributes as Record<string, unknown>)["yaw_deg"]);
  return Number.isFinite(value) ? value : null;
}

export function attrNumber(attributes: unknown, key: string): number | null {
  if (!attributes || typeof attributes !== "object") return null;
  const value = Number((attributes as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : null;
}

export function defaultWallYaw(wall: string): number {
  if (wall === "north") return 180;
  if (wall === "south") return 0;
  if (wall === "east") return 270;
  if (wall === "west") return 90;
  return 0;
}

export function isWall(v: unknown): v is WallKey {
  return v === "north" || v === "east" || v === "south" || v === "west";
}

/**
 * NOTE ON AXES. The plan uses +y = compass north. Three.js uses +z = "south"
 * on screen, so the north wall sits at z = -length/2 and the south wall at
 * z = +length/2. Object `y_m` maps straight onto `z`; keeping that mapping in
 * one place is what stopped the point cloud drifting away from the 3D view.
 */
export function placeObjects(
  width: number,
  length: number,
  height: number,
  objects: RawObject[],
): PlacedObject[] {
  return objects.map((o, i) => {
    const w = clamp(n(o.width_m, 0.5), 0.05, width);
    const d = clamp(n(o.depth_m, 0.5), 0.05, length);
    const h = clamp(n(o.height_m, 0.5), 0.05, height);
    const bottom = clamp(
      attrNumber(o.attributes, "floor_elevation_m") ?? 0,
      0,
      Math.max(0, height - h),
    );
    const wall = String(o.against_wall ?? attrWall(o.attributes) ?? "").toLowerCase();
    const rawYaw = o.yaw_deg ?? attrYaw(o.attributes);
    const storedYaw = rawYaw == null ? defaultWallYaw(wall) : n(rawYaw, defaultWallYaw(wall));
    const yawDeg = ((storedYaw % 360) + 360) % 360;
    const yawRad = (yawDeg * Math.PI) / 180;
    const halfX = (Math.abs(Math.cos(yawRad)) * w) / 2 + (Math.abs(Math.sin(yawRad)) * d) / 2;
    const halfZ = (Math.abs(Math.sin(yawRad)) * w) / 2 + (Math.abs(Math.cos(yawRad)) * d) / 2;
    const xLimit = Math.max(0, width / 2 - halfX);
    const zLimit = Math.max(0, length / 2 - halfZ);
    let x = clamp(n(o.x_m, 0), -xLimit, xLimit);
    // Local CRS: +y is north. Three.js draws north away from the camera, so
    // the plan's +y maps to -z.
    let y = clamp(n(o.y_m, 0), -zLimit, zLimit);
    // Snap flush to the declared wall AFTER clamping, so a piano recorded
    // against the north wall never renders a few centimeters proud of it.
    if (wall === "north") y = zLimit;
    else if (wall === "south") y = -zLimit;
    else if (wall === "east") x = xLimit;
    else if (wall === "west") x = -xLimit;
    return {
      id: o.id ?? `obj-${i}`,
      label: o.label ?? "object",
      category: (o.category ?? "other").toLowerCase(),
      x,
      z: -y,
      w,
      d,
      h,
      bottom,
      yawRad,
      yawDeg,
    };
  });
}

export function placePortals(
  width: number,
  length: number,
  height: number,
  portals: RawPortal[],
): PlacedPortal[] {
  return portals.map((p, i) => {
    const wall: WallKey = isWall(String(p.wall ?? "").toLowerCase())
      ? (String(p.wall).toLowerCase() as WallKey)
      : "north";
    const run = wall === "north" || wall === "south" ? width : length;
    const kind = String(p.kind ?? "door");
    const isWindow = /window|glaz/i.test(kind);

    const w = clamp(n(p.width_m, 0.9), 0.15, Math.max(run, 0.15));
    const offset = clamp(n(p.offset_m, 0), 0, Math.max(run - w, 0));
    const h = clamp(n(p.height_m, isWindow ? 1.3 : 2.03), 0.15, height);
    // Use the measured sill when the reconstruction reported one. Doors,
    // archways and open thresholds sit on the floor; a window defaults to a
    // 0.9 m sill only when nothing was measured. Either way the head is pinned
    // so the opening never punches through the ceiling.
    const measuredSill =
      typeof p.sill_m === "number" && Number.isFinite(p.sill_m) ? p.sill_m : null;
    const sillRaw = measuredSill ?? (isWindow ? 0.9 : 0);
    const sill = clamp(sillRaw, 0, Math.max(height - h - 0.02, 0));

    const center = offset + w / 2;
    let x = 0;
    let z = 0;
    // North (+y) is at -z on screen; wall offsets run west->east on the
    // north/south walls and south->north on the east/west walls.
    if (wall === "north") {
      x = -width / 2 + center;
      z = -length / 2;
    } else if (wall === "south") {
      x = -width / 2 + center;
      z = length / 2;
    } else if (wall === "east") {
      x = width / 2;
      z = length / 2 - center;
    } else {
      x = -width / 2;
      z = length / 2 - center;
    }

    return {
      id: p.id ?? `portal-${i}`,
      kind,
      wall,
      isWindow,
      offset,
      w,
      h,
      sill,
      x,
      z,
      y: sill + h / 2,
    };
  });
}

/** True when the (u, v) point on `wall` falls inside any opening. */
export function portalHitTest(portals: PlacedPortal[], wall: WallKey, u: number, v: number) {
  for (const p of portals) {
    if (p.wall !== wall) continue;
    if (u >= p.offset && u <= p.offset + p.w && v >= p.sill && v <= p.sill + p.h) return true;
  }
  return false;
}

/** Maps a distance along a wall run to room-center coordinates. */
export function wallPoint(
  wall: WallKey,
  u: number,
  width: number,
  length: number,
): [number, number] {
  if (wall === "north") return [-width / 2 + u, -length / 2];
  if (wall === "south") return [-width / 2 + u, length / 2];
  if (wall === "east") return [width / 2, length / 2 - u];
  return [-width / 2, length / 2 - u];
}

export const WALLS: { key: WallKey; run: (w: number, l: number) => number }[] = [
  { key: "north", run: (w) => w },
  { key: "south", run: (w) => w },
  { key: "east", run: (_w, l) => l },
  { key: "west", run: (_w, l) => l },
];
