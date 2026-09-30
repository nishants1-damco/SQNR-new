// Per-viewpoint object detection. Showing the model 32-40 frames in one call
// dilutes its attention and costs recall, so frames are split into small
// batches — one viewpoint, at most MAX_FRAMES_PER_BATCH frames — detected in
// parallel, and the per-batch lists are merged back into one inventory.
//
// The merge normally runs as a text-only model call (it understands that "TV"
// and "wall-mounted television" seen from two corners are one object);
// `mergeBatchInventories` is the deterministic fallback if that call fails.
//
// Pure module: no server imports, safe in tests.

export const MAX_FRAMES_PER_BATCH = 8;

export interface ViewpointFrame<B> {
  heading: number | null;
  /** The frame's caption and image blocks, in order. */
  blocks: B[];
}

export interface DetectionBatch<B> {
  station: number;
  /** Human-readable scope for the prompt, e.g. "viewpoint 2, headings 95°–215°". */
  scope: string;
  blocks: B[];
}

/** Split each viewpoint's frames into batches of at most `maxFrames`. */
export function batchViewpoints<B>(
  viewpoints: { station: number; frames: ViewpointFrame<B>[] }[],
  maxFrames = MAX_FRAMES_PER_BATCH,
): DetectionBatch<B>[] {
  const batches: DetectionBatch<B>[] = [];
  for (const { station, frames } of viewpoints) {
    for (let start = 0; start < frames.length; start += maxFrames) {
      const slice = frames.slice(start, start + maxFrames);
      const headings = slice
        .map((f) => f.heading)
        .filter((h): h is number => typeof h === "number")
        .map((h) => Math.round(((h % 360) + 360) % 360));
      const where = station === 0 ? "room center" : "near a room corner";
      const range = headings.length ? `, headings ${headings.map((h) => `${h}°`).join(", ")}` : "";
      batches.push({
        station,
        scope: `viewpoint ${station + 1} (${where})${range}`,
        blocks: slice.flatMap((f) => f.blocks),
      });
    }
  }
  return batches;
}

/** Words that describe an object's look, not what it is. */
const DESCRIPTIVE = new Set(
  [
    "a an the large small big tall low long short wide narrow",
    "black white grey gray brown beige cream blue green red yellow dark light",
    "wooden wood leather fabric metal glass marble oak walnut upholstered",
    "wall mounted freestanding built in modern vintage",
  ]
    .join(" ")
    .split(" "),
);

/** Same word for the same kind of thing ("TV" / "television", "couch" / "sofa"). */
const SYNONYMS: Record<string, string> = {
  tv: "television",
  telly: "television",
  couch: "sofa",
  settee: "sofa",
  fridge: "refrigerator",
  bookshelf: "bookcase",
  credenza: "console",
};

/** Canonical identity of a detection's label, ignoring colors and materials. */
export function canonicalObjectLabel(label: unknown): string {
  return String(label ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !DESCRIPTIVE.has(w))
    .map((w) => SYNONYMS[w] ?? w)
    .join(" ");
}

interface Detection {
  label?: unknown;
  against_wall?: unknown;
  confidence?: unknown;
  supporting_headings_deg?: unknown;
  frame_boxes?: unknown;
}

const keyOf = (o: Detection) =>
  `${canonicalObjectLabel(o.label)}|${String(o.against_wall ?? "none").toLowerCase()}`;

const boxArea = (b: { x0?: number; y0?: number; x1?: number; y1?: number }) =>
  Math.abs((b.x1 ?? 0) - (b.x0 ?? 0)) * Math.abs((b.y1 ?? 0) - (b.y0 ?? 0));

const headingsOf = (o: Detection) =>
  Array.isArray(o.supporting_headings_deg)
    ? o.supporting_headings_deg.filter((h): h is number => typeof h === "number")
    : [];

/**
 * Deterministic merge. Within one viewpoint, batches cover different headings,
 * so their counts add up. Across viewpoints the same object is usually seen
 * again, so the viewpoint that saw the most of a kind sets the count — four
 * chairs seen from one corner stay four, one sofa seen from four corners stays
 * one. Each kept detection gathers the headings of its matches elsewhere.
 */
export function mergeBatchInventories<T extends Detection>(
  batches: { station: number; objects: T[] }[],
): T[] {
  const byStation = new Map<number, Map<string, T[]>>();
  for (const { station, objects } of batches) {
    const groups = byStation.get(station) ?? new Map<string, T[]>();
    for (const o of objects) {
      const key = keyOf(o);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    byStation.set(station, groups);
  }

  const keys = new Set([...byStation.values()].flatMap((g) => [...g.keys()]));
  const merged: T[] = [];
  for (const key of keys) {
    const lists = [...byStation.values()].map((g) => g.get(key) ?? []);
    const richest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    richest.forEach((o, i) => {
      const matches = lists.map((list) => list[i]).filter((m): m is T => !!m);
      const confidence = Math.max(...matches.map((m) => Number(m.confidence) || 0));
      const headings = [...new Set(matches.flatMap(headingsOf))];
      // Keep the three largest boxes across sightings: the clearest crops.
      const boxes = matches
        .flatMap((m) => (Array.isArray(m.frame_boxes) ? m.frame_boxes : []))
        .map((b) => b as { x0?: number; y0?: number; x1?: number; y1?: number })
        .sort((a, b) => boxArea(b) - boxArea(a))
        .slice(0, 3);
      merged.push({
        ...o,
        confidence,
        supporting_headings_deg: headings,
        ...(boxes.length ? { frame_boxes: boxes } : {}),
      });
    });
  }
  return merged;
}
