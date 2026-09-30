// Per-viewpoint capture health: which standing position (the room center or
// a corner) produced frames good enough to reconstruct from, and which one
// the user should go back to and reshoot.
//
// Works from per-frame metadata only (station, compass heading, motion and
// the capture-time quality flag), so the capture review screen and the space
// page reach the same verdict without re-reading any images. Deliberately
// uses no walked distances: a corner's place in the room comes from where
// its sweep was pointing, not from counting steps.
//
// Pure module: safe in the browser and in tests.

/** Directions the center 360° sweep aims for (one per 22.5° bin). */
export const CENTER_DIRECTIONS = 16;
/** Directions a corner's 120° sweep aims for. */
export const CORNER_DIRECTIONS = 4;

const CENTER_BIN_DEG = 360 / CENTER_DIRECTIONS;
/** Corner frames closer than this in heading count as the same direction. */
const SAME_DIRECTION_DEG = 20;
/** Same cut-off the capture loop uses for "the phone was still swinging". */
const MOVING_MOTION_ENERGY = 0.9;

export interface StationFrame {
  station: number | null | undefined;
  heading_deg: number | null | undefined;
  motion_energy?: number | null | undefined;
  /** Capture-time verdict: low contrast or shot while moving. */
  weak?: boolean | null | undefined;
}

export type StationStatus = "good" | "reshoot";

/** Which part of the room a corner viewpoint stands in (compass quadrant). */
export type RoomSide = "NE" | "SE" | "SW" | "NW";

export interface StationHealth {
  station: number;
  kind: "center" | "corner";
  label: string;
  frames: number;
  expected: number;
  /** Distinct directions with at least one frame. */
  covered: number;
  /** Directions where every frame was weak (blurry or too dark). */
  blurry: number;
  status: StationStatus;
  reasons: string[];
  /** Corner placement for the room map; null for the center or no headings. */
  side: RoomSide | null;
}

/** Health input from a stored `scan_photos` row. */
export function stationFrameFromPhoto(photo: {
  heading_deg: number | string | null;
  sensor_payload: unknown;
}): StationFrame {
  const payload = (photo.sensor_payload ?? {}) as Record<string, unknown>;
  const quality = (payload["quality"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const heading = photo.heading_deg == null ? null : Number(photo.heading_deg);
  return {
    station: num(payload["station"]),
    heading_deg: heading != null && Number.isFinite(heading) ? heading : null,
    motion_energy: num(payload["motion_energy"]),
    weak: typeof quality["weak"] === "boolean" ? quality["weak"] : null,
  };
}

export function stationLabel(station: number): string {
  return station === 0 ? "Center" : `Corner ${station}`;
}

/** Fewest directions a viewpoint needs — the capture loop's own cut-off. */
export function minimumDirections(expected: number): number {
  return Math.min(expected, Math.max(3, expected - 2));
}

const norm = (deg: number) => ((deg % 360) + 360) % 360;

function circularMean(headings: number[]): number {
  let sin = 0;
  let cos = 0;
  for (const h of headings) {
    sin += Math.sin((h * Math.PI) / 180);
    cos += Math.cos((h * Math.PI) / 180);
  }
  return norm((Math.atan2(sin, cos) * 180) / Math.PI);
}

function isWeak(frame: StationFrame): boolean {
  if (typeof frame.weak === "boolean") return frame.weak;
  return (frame.motion_energy ?? 0) > MOVING_MOTION_ENERGY;
}

/** Group frames into the distinct directions they cover. */
function directionGroups(frames: StationFrame[], kind: "center" | "corner"): StationFrame[][] {
  const withHeading = frames.filter((f) => typeof f.heading_deg === "number");
  if (kind === "center") {
    const bins = new Map<number, StationFrame[]>();
    for (const f of withHeading) {
      const bin = Math.floor(norm(f.heading_deg as number) / CENTER_BIN_DEG) % CENTER_DIRECTIONS;
      bins.set(bin, [...(bins.get(bin) ?? []), f]);
    }
    return [...bins.values()];
  }
  // A corner sweep spans ~120°, so measure headings relative to its mean to
  // keep a sweep across north from splitting at 0°/360°.
  if (withHeading.length === 0) return [];
  const mean = circularMean(withHeading.map((f) => f.heading_deg as number));
  const offset = (f: StationFrame) => norm((f.heading_deg as number) - mean + 180) - 180;
  const sorted = [...withHeading].sort((a, b) => offset(a) - offset(b));
  const groups: StationFrame[][] = [];
  let last = -Infinity;
  for (const f of sorted) {
    const o = offset(f);
    if (o - last > SAME_DIRECTION_DEG || groups.length === 0) groups.push([f]);
    else groups[groups.length - 1]?.push(f);
    last = o;
  }
  return groups;
}

/**
 * A corner sweep looks into the room, so the corner itself sits on the
 * opposite side of the room from where the sweep was pointing.
 */
function cornerSide(frames: StationFrame[]): RoomSide | null {
  const headings = frames
    .map((f) => f.heading_deg)
    .filter((h): h is number => typeof h === "number");
  if (headings.length === 0) return null;
  const bearing = norm(circularMean(headings) + 180);
  return bearing < 90 ? "NE" : bearing < 180 ? "SE" : bearing < 270 ? "SW" : "NW";
}

/**
 * Health of every viewpoint from 0 to the highest one seen. A gap (all of a
 * viewpoint's frames removed, e.g. by the privacy purge) is reported too.
 */
export function assessStations(frames: StationFrame[]): StationHealth[] {
  const byStation = new Map<number, StationFrame[]>();
  for (const f of frames) {
    const station = typeof f.station === "number" && f.station >= 0 ? f.station : 0;
    byStation.set(station, [...(byStation.get(station) ?? []), f]);
  }
  if (byStation.size === 0) return [];

  const highest = Math.max(...byStation.keys());
  const result: StationHealth[] = [];
  for (let station = 0; station <= highest; station++) {
    const own = byStation.get(station) ?? [];
    const kind = station === 0 ? "center" : "corner";
    const expected = kind === "center" ? CENTER_DIRECTIONS : CORNER_DIRECTIONS;
    const groups = directionGroups(own, kind);
    const covered = Math.min(expected, groups.length);
    const blurry = groups.filter((g) => g.every(isWeak)).length;

    const reasons: string[] = [];
    if (own.length === 0) {
      reasons.push("No frames from this viewpoint");
    } else {
      if (covered < minimumDirections(expected)) {
        reasons.push(`Only ${covered} of ${expected} directions captured`);
      }
      if (blurry > Math.floor(expected / 4)) {
        reasons.push(`${blurry} of ${covered} directions are blurry or too dark`);
      }
    }

    result.push({
      station,
      kind,
      label: stationLabel(station),
      frames: own.length,
      expected,
      covered,
      blurry,
      status: reasons.length ? "reshoot" : "good",
      reasons,
      side: kind === "corner" ? cornerSide(own) : null,
    });
  }
  return result;
}
