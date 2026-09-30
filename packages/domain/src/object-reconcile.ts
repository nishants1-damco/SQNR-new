// Restoring confident detections that a later pass dropped — without
// duplicating objects that a later pass merely renamed.
//
// Passes rename freely ("TV" / "flat-screen smart TV (Google TV, ~40-43 in)"),
// so objects are matched by type (their category), not by label, and counted:
// a type is restored only when the later list has fewer confident instances
// of it than the earlier one, and then the earlier instances farthest from the
// kept ones are the ones restored.
//
// Door and window parts are never restored: they belong to the portals, and
// the review removes them from the object list on purpose.
//
// Pure module: safe in tests.

import { canonicalObjectLabel } from "./inventory-merge";

export interface ReconcilableObject {
  label?: unknown;
  category?: unknown;
  confidence?: unknown;
  x_m?: unknown;
  y_m?: unknown;
}

/** Different words for one type of object, after canonicalObjectLabel. */
const TYPE_ALIASES: Record<string, string> = {
  tv: "television",
  "air conditioner": "hvac unit",
  "ac unit": "hvac unit",
  ac: "hvac unit",
  "split ac": "hvac unit",
  hvac: "hvac unit",
  shelf: "shelving",
  shelves: "shelving",
  "wall unit": "shelving",
  couch: "sofa",
  "sofa bed": "sofa",
  diwan: "sofa",
};

/** Words that make an object part of a door or window opening. */
const PORTAL_PART_WORDS = ["door", "doors", "window", "windows", "doorway", "archway", "gate"];
/** "door leaf", "window pane": a part named after its opening. */
const PORTAL_PIECE_WORDS = ["leaf", "panel", "pane", "frame", "shutter", "grille", "grill"];
/** Words after which a label describes where the object is, not what it is. */
const LOCATION_WORDS = new Set(
  "with by near under beside behind next to on above below at in front of against".split(" "),
);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** An object's type: its category (or, without one, its label's last word), normalized. */
export function objectType(o: ReconcilableObject): string {
  const fromCategory = canonicalObjectLabel(o.category);
  const base = fromCategory || canonicalObjectLabel(o.label).split(" ").pop() || "object";
  return TYPE_ALIASES[base] ?? base;
}

/**
 * True for doors, windows and their parts. Judged by the category and the
 * label's head noun only: "chair by the window" is a chair, while "sliding
 * bathroom door with dark frame" and "entry door leaf" are door parts.
 */
export function isPortalPart(o: ReconcilableObject): boolean {
  if (
    canonicalObjectLabel(o.category)
      .split(" ")
      .some((w) => PORTAL_PART_WORDS.includes(w))
  ) {
    return true;
  }
  // Parenthetical notes ("(open)", "(upper part of the entry)") aren't the name.
  const words = (String(o.label ?? "").split("(")[0] ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const cut = words.findIndex((w) => LOCATION_WORDS.has(w));
  const head = cut === -1 ? words : words.slice(0, cut);
  const last = head[head.length - 1] ?? "";
  const beforeLast = head[head.length - 2] ?? "";
  return (
    PORTAL_PART_WORDS.includes(last) ||
    (PORTAL_PIECE_WORDS.includes(last) && PORTAL_PART_WORDS.includes(beforeLast))
  );
}

const distance = (a: ReconcilableObject, b: ReconcilableObject) => {
  const ax = num(a.x_m);
  const ay = num(a.y_m);
  const bx = num(b.x_m);
  const by = num(b.y_m);
  return ax == null || ay == null || bx == null || by == null ? 0 : Math.hypot(ax - bx, ay - by);
};

/**
 * The objects from `earlier` to add back to `kept`: for each type, as many of
 * the confident earlier instances as `kept` is short of, farthest-from-kept
 * first. Portal parts and low-confidence detections are never restored.
 */
export function objectsToRestore<T extends ReconcilableObject>(
  kept: ReconcilableObject[],
  earlier: T[],
  minConfidence: number,
): T[] {
  const keptByType = new Map<string, ReconcilableObject[]>();
  for (const o of kept) {
    const type = objectType(o);
    keptByType.set(type, [...(keptByType.get(type) ?? []), o]);
  }
  const eligibleByType = new Map<string, T[]>();
  for (const o of earlier) {
    if (isPortalPart(o) || (num(o.confidence) ?? 0) < minConfidence) continue;
    const type = objectType(o);
    eligibleByType.set(type, [...(eligibleByType.get(type) ?? []), o]);
  }

  const restore: T[] = [];
  for (const [type, eligible] of eligibleByType) {
    const same = keptByType.get(type) ?? [];
    const deficit = eligible.length - same.length;
    if (deficit <= 0) continue;
    const farthest = eligible
      .map((o) => ({
        o,
        gap: same.length ? Math.min(...same.map((k) => distance(o, k))) : Infinity,
      }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, deficit)
      .map(({ o }) => o);
    restore.push(...farthest);
  }
  return restore;
}
