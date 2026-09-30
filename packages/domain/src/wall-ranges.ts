/**
 * One measured distance from the phone to the surface it was pointed at.
 * Produced by the browser acoustics probe; defined here so the probe (web)
 * and the shell solver (worker) share one type.
 */
export interface WallRange {
  /** Viewpoint where this range was measured. */
  station?: number;
  /** Compass heading the phone was facing when the chirp fired. */
  heading_deg: number | null;
  /** Meters from the phone to the nearest large flat surface on that bearing. */
  distance_m: number;
  /** Direct-to-first-reflection delay in milliseconds. */
  delay_ms: number;
  /** Peak level above the measured noise floor; below ~5 dB we discard. */
  snr_db: number;
  measured_at: string;
}

export type Cardinal = "north" | "east" | "south" | "west";

const CARDINALS: { name: Cardinal; bearing: number }[] = [
  { name: "north", bearing: 0 },
  { name: "east", bearing: 90 },
  { name: "south", bearing: 180 },
  { name: "west", bearing: 270 },
];

function angleDelta(a: number, b: number) {
  let d = ((a - b + 540) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

export interface MeasuredWall {
  wall: Cardinal;
  /** Perpendicular distance from the capture point to that wall, in meters. */
  distance_m: number;
  samples: number;
  snr_db: number;
}

export interface MeasuredShell {
  walls: MeasuredWall[];
  /** East-west run, only when both the east and west walls were ranged. */
  width_m: number | null;
  /** North-south run, only when both the north and south walls were ranged. */
  length_m: number | null;
  /** Lower bounds from single-sided measurements, always available. */
  min_width_m: number | null;
  min_length_m: number | null;
  basis: string;
}

/**
 * Fold a set of directional chirps into per-wall distances. Each chirp is
 * assigned to the cardinal it was pointed nearest to, and its slant range is
 * projected onto that wall normal, so a chirp fired 20 degrees off the wall
 * still contributes an honest perpendicular distance.
 */
export function shellFromRanges(ranges: WallRange[]): MeasuredShell | null {
  // A shell is only the sum of opposite distances when every reading came
  // from one physical point. In multi-station captures, use the center
  // viewpoint only; corner ranges remain useful to the graph solve below.
  const stationIds = new Set(
    ranges.map((r) => r.station).filter((station): station is number => Number.isFinite(station)),
  );
  const shellRanges = stationIds.size > 1 ? ranges.filter((r) => r.station === 0) : ranges;
  const usable = shellRanges.filter(
    (r) =>
      r &&
      typeof r.heading_deg === "number" &&
      r.distance_m > 0.5 &&
      // A phone near the middle of a domestic room is never more than ~7 m from
      // the wall it is pointed at. Anything longer is late reverb, not a wall.
      r.distance_m <= 6.8 &&
      r.snr_db >= 8,
  );
  if (usable.length === 0) return null;

  const buckets = new Map<Cardinal, { d: number[]; snr: number[] }>();
  for (const r of usable) {
    const heading = r.heading_deg as number;
    let best: { name: Cardinal; off: number } | null = null;
    for (const c of CARDINALS) {
      const off = Math.abs(angleDelta(heading, c.bearing));
      if (!best || off < best.off) best = { name: c.name, off };
    }
    // Beyond 35 degrees off a wall normal the projection stops being reliable.
    if (!best || best.off > 35) continue;
    const perpendicular = r.distance_m * Math.cos((best.off * Math.PI) / 180);
    const bucket = buckets.get(best.name) ?? { d: [], snr: [] };
    bucket.d.push(perpendicular);
    bucket.snr.push(r.snr_db);
    buckets.set(best.name, bucket);
  }
  if (buckets.size === 0) return null;

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  };

  const walls: MeasuredWall[] = [...buckets.entries()]
    .filter(([, b]) => {
      if (b.d.length < 2) return false;
      // Two chirps at the same wall must agree to within 25 percent, otherwise
      // one of them found furniture, a person, or nothing at all.
      const lo = Math.min(...b.d);
      const hi = Math.max(...b.d);
      return hi - lo <= Math.max(0.4, lo * 0.25);
    })
    .map(([wall, b]) => ({
      wall,
      distance_m: Math.round(median(b.d) * 100) / 100,
      samples: b.d.length,
      snr_db: Math.round(median(b.snr) * 10) / 10,
    }));
  if (walls.length === 0) return null;

  const at = (wall: Cardinal) => walls.find((w) => w.wall === wall)?.distance_m ?? null;
  const north = at("north");
  const south = at("south");
  const east = at("east");
  const west = at("west");

  const round = (v: number) => Math.round(v * 100) / 100;
  // A ranged run has to be a plausible room: below 1.6 m it is a cupboard,
  // above 13 m it is not something a phone speaker measured honestly.
  const plausible = (v: number | null) => (v != null && v >= 1.6 && v <= 13 ? round(v) : null);
  const width = east != null && west != null ? plausible(east + west) : null;
  const length = north != null && south != null ? plausible(north + south) : null;
  const minWidth =
    east != null || west != null ? plausible(Math.max(east ?? 0, west ?? 0) + 0.6) : null;
  const minLength =
    north != null || south != null ? plausible(Math.max(north ?? 0, south ?? 0) + 0.6) : null;

  return {
    walls,
    width_m: width,
    length_m: length,
    min_width_m: minWidth,
    min_length_m: minLength,
    basis: `${usable.length} acoustic range chirps folded into ${walls.length} wall distances`,
  };
}

/** Human-readable line for the reconstruction prompt. */
export function describeMeasuredShell(shell: MeasuredShell): string {
  const parts = shell.walls
    .map((w) => `${w.wall} wall ${w.distance_m} m away (${w.samples} chirps, ${w.snr_db} dB SNR)`)
    .join("; ");
  const constraints: string[] = [];
  if (shell.width_m) constraints.push(`east-west run measures ${shell.width_m} m`);
  if (shell.length_m) constraints.push(`north-south run measures ${shell.length_m} m`);
  if (!shell.width_m && shell.min_width_m)
    constraints.push(`east-west run is at least ${shell.min_width_m} m`);
  if (!shell.length_m && shell.min_length_m)
    constraints.push(`north-south run is at least ${shell.min_length_m} m`);
  return [
    `MEASURED ACOUSTIC RANGING from the capture point: ${parts}.`,
    constraints.length
      ? `${constraints.join(", ")}. These are time-of-flight measurements, not estimates: keep width_m and length_m within 10 percent of them and rescale objects and portals to match rather than overriding them from the imagery.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
