/**
 * Landmark bookkeeping between the vision pass and the graph solve.
 *
 * The model looks at each frame and reports the stable, fixed features it can
 * see with their horizontal position in the image. A frame knows its compass
 * heading and its field of view, so an image column converts straight into a
 * world bearing. The same feature named from two different standing positions
 * gives two rays, and two rays give a position.
 *
 * Architecture is the backbone, because it cannot move. Large fixed objects
 * such as a television, piano or bookcase count too: they are distinct, they
 * have clean vertical edges, and a capture usually sees them from several
 * viewpoints, which is exactly what triangulation needs.

 */

import type { BearingObservation } from "./graph-solve";

export interface RawSighting {
  /** Frame index as presented to the model. */
  frame: number;
  /** Free-text feature name, e.g. "archway left edge". */
  feature: string;
  /** Horizontal position in the image, 0 at the left edge, 1 at the right. */
  image_x: number;
  confidence?: number;
}

export interface FrameGeometry {
  frame: number;
  station: number;
  heading_deg: number | null;
  fov_deg: number | null;
}

/**
 * Feature kinds worth triangulating. Architecture first, because it cannot
 * move, then the large fixed objects a room reliably shows from more than one
 * standing position. Nothing here is room-specific: it is the generic
 * vocabulary a vision pass uses for "distinct thing with vertical edges".
 */
const LANDMARK_KINDS = [
  // architecture
  "window",
  "door",
  "doorway",
  "arch",
  "archway",
  "opening",
  "portal",
  "corner",
  "junction",
  "wall",
  "column",
  "pillar",
  "mantle",
  "mantel",
  "fireplace",
  "niche",
  "alcove",
  "beam",
  "vent",
  "radiator",
  "baseboard",
  "closet",
  "stair",
  // large fixed objects, usable as centering targets from several viewpoints
  "television",
  "tv",
  "screen",
  "monitor",
  "piano",
  "bookcase",
  "bookshelf",
  "shelf",
  "cabinet",
  "console",
  "desk",
  "table",
  "sofa",
  "couch",
  "bed",
  "mirror",
  "artwork",
  "picture",
  "painting",
  "clock",
  "lamp",
  "rug",
  "counter",
  "sink",
  "appliance",
  "refrigerator",
];

/** Words that name a sub-part of a feature rather than a different feature. */
const EDGE_WORDS = [
  "left",
  "right",
  "top",
  "bottom",
  "upper",
  "lower",
  "near",
  "far",
  "inner",
  "outer",
];

const SYNONYM: Record<string, string> = {
  tv: "television",
  screen: "television",
  monitor: "television",
  mantel: "mantle",
  couch: "sofa",
  bookshelf: "bookcase",
  doorway: "door",
  archway: "arch",
  painting: "artwork",
  picture: "artwork",
};

/** Filler words that never distinguish one feature from another. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "on",
  "in",
  "at",
  "to",
  "and",
  "with",
  "edge",
  "side",
  "front",
  "back",
  "large",
  "small",
  "big",
  "tall",
  "wide",
  "dark",
  "light",
  "white",
  "black",
  "brown",
  "wood",
  "wooden",
  "glass",
  "metal",
  "frame",
  "visible",
  "partial",
  "part",
  "this",
  "that",
  "room",
  "its",
  "one",
  "two",
]);

/**
 * Canonical id for a feature name so the same thing described slightly
 * differently from two stations still matches. Keeps the side word, because
 * the left and right edge of one archway are genuinely two landmarks.
 */
export function landmarkId(feature: string): string | null {
  const text = feature
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const words = text.split(" ");
  const known =
    LANDMARK_KINDS.find((a) => words.includes(a)) ?? LANDMARK_KINDS.find((a) => text.includes(a));
  // Fall back to the first meaningful noun so an unusual but consistently
  // named feature still links across viewpoints instead of being discarded.
  const raw =
    known ??
    words.find(
      (w) => w.length > 2 && !STOPWORDS.has(w) && !EDGE_WORDS.includes(w) && !/^\d+$/.test(w),
    );
  if (!raw) return null;
  const kind = SYNONYM[raw] ?? raw;
  const side = EDGE_WORDS.filter((e) => words.includes(e));
  // An ordinal such as "window 2" distinguishes two of the same kind.
  const ordinal = words.find((w) => /^[0-9]$/.test(w));
  return [kind, ...side, ordinal].filter(Boolean).join("-");
}

/**
 * Turns image-space sightings into world bearings.
 *
 * A frame's heading is the direction of its optical center, so a feature at
 * image column u sits (u - 0.5) * fov degrees off that heading. Frames with no
 * compass reading contribute nothing and are dropped rather than guessed at.
 */
export function sightingsToBearings(
  sightings: RawSighting[],
  frames: FrameGeometry[],
  defaultFovDeg = 65,
): BearingObservation[] {
  const byFrame = new Map(frames.map((f) => [f.frame, f]));
  const out: BearingObservation[] = [];
  for (const s of sightings) {
    const frame = byFrame.get(s.frame);
    if (!frame || frame.heading_deg == null) continue;
    if (!Number.isFinite(s.image_x)) continue;
    const u = Math.max(0, Math.min(1, s.image_x));
    const id = landmarkId(s.feature);
    if (!id) continue;
    const fov = frame.fov_deg && frame.fov_deg > 20 ? frame.fov_deg : defaultFovDeg;
    const bearing = (((frame.heading_deg + (u - 0.5) * fov) % 360) + 360) % 360;
    // Features near the frame edge suffer most from lens distortion and from
    // heading lag, so they weigh less than ones near the optical center.
    const edgePenalty = 1 - 0.4 * Math.min(1, Math.abs(u - 0.5) * 2);
    const confidence =
      typeof s.confidence === "number" ? Math.max(0.1, Math.min(1, s.confidence)) : 0.7;
    out.push({
      station: frame.station,
      landmark: id,
      bearing_deg: Math.round(bearing * 10) / 10,
      weight: Math.round(confidence * edgePenalty * 100) / 100,
    });
  }
  return out;
}

/**
 * Collapses repeat sightings of one landmark from one station into a single
 * bearing. Several frames from the same spot see the same corner; averaging
 * them stops one station from out-voting the others purely on frame count.
 */
export function consolidate(bearings: BearingObservation[]): BearingObservation[] {
  const groups = new Map<string, BearingObservation[]>();
  for (const b of bearings) {
    const key = `${b.station}::${b.landmark}`;
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  const out: BearingObservation[] = [];
  for (const list of groups.values()) {
    const first = list[0] as BearingObservation;
    if (list.length === 1) {
      out.push(first);
      continue;
    }
    // Circular mean so bearings either side of north average correctly.
    let sx = 0;
    let sy = 0;
    let w = 0;
    for (const b of list) {
      const rad = (b.bearing_deg * Math.PI) / 180;
      sx += Math.sin(rad) * b.weight;
      sy += Math.cos(rad) * b.weight;
      w += b.weight;
    }
    const mean = ((((Math.atan2(sx, sy) * 180) / Math.PI) % 360) + 360) % 360;
    // Agreement between the repeats is itself evidence, so a tight cluster
    // gains confidence and a scattered one loses it.
    const spread =
      list.reduce((s, b) => {
        const d = Math.abs(((b.bearing_deg - mean + 540) % 360) - 180);
        return s + d;
      }, 0) / list.length;
    const agreement = Math.max(0.3, 1 - spread / 15);
    out.push({
      station: first.station,
      landmark: first.landmark,
      bearing_deg: Math.round(mean * 10) / 10,
      weight: Math.round(Math.min(1, (w / list.length) * agreement) * 100) / 100,
    });
  }
  return out;
}

/** Landmarks with rays from at least two different stations. */
export function sharedLandmarks(bearings: BearingObservation[]): string[] {
  const stations = new Map<string, Set<number>>();
  for (const b of bearings) {
    const set = stations.get(b.landmark) ?? new Set<number>();
    set.add(b.station);
    stations.set(b.landmark, set);
  }
  return [...stations.entries()].filter(([, s]) => s.size >= 2).map(([id]) => id);
}

/** Prompt text describing solved landmark positions as fixed facts. */
export function describeSolvedLandmarks(
  landmarks: { id: string; x: number; y: number; sightings: number }[],
  residualDeg: number,
): string {
  if (landmarks.length === 0) return "";
  const list = landmarks
    .slice(0, 14)
    .map((l) => `${l.id} at x=${l.x} m east, y=${l.y} m north (${l.sightings} sightings)`)
    .join("; ");
  return [
    `TRIANGULATED ARCHITECTURE: these fixed features were each seen from two or more standing positions and their positions were solved geometrically, not estimated visually.`,
    `Room coordinates, origin at the room center, +x east and +y north: ${list}.`,
    `Mean angular disagreement after the solve is ${residualDeg}°.`,
    `Treat these as measurements. Every window, door and archway you report must sit at the solved position of its landmark, and the room's walls must enclose all of them.`,
  ].join(" ");
}
