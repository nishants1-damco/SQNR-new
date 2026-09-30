// Which captured frames go to the model.
//
// A corner sweep is four deliberate directions ~40° apart (plus the downward
// view), and a weak frame may have been re-shot in the same direction. Keep
// the best frame of each direction — never sample a corner by wide compass
// sectors, which merges neighbouring directions and silently drops half of
// the corner's views.
//
// Pure module: safe in tests.

export interface SelectableFrame {
  heading_deg: number | null;
  /** Laplacian variance from capture (higher is sharper); absent on older frames. */
  sharpness?: number | null;
  pose?: { motion_energy?: number | null } | null;
  view?: string | null;
}

/** Corner frames closer than this in heading count as the same direction. */
const SAME_DIRECTION_DEG = 20;

const norm = (deg: number) => ((deg % 360) + 360) % 360;

/** True when `a` is the better frame of a direction: sharper, else steadier. */
export function isBetterFrame(a: SelectableFrame, b: SelectableFrame): boolean {
  if (typeof a.sharpness === "number" && typeof b.sharpness === "number") {
    return a.sharpness > b.sharpness;
  }
  const motion = (f: SelectableFrame) =>
    typeof f.pose?.motion_energy === "number" ? f.pose.motion_energy : 0.4;
  return motion(a) < motion(b);
}

function circularMean(headings: number[]): number {
  let sin = 0;
  let cos = 0;
  for (const h of headings) {
    sin += Math.sin((h * Math.PI) / 180);
    cos += Math.cos((h * Math.PI) / 180);
  }
  return norm((Math.atan2(sin, cos) * 180) / Math.PI);
}

/**
 * Best frame per direction of one corner sweep, in sweep order, capped at
 * `maxLevel` directions, followed by the best downward view if wanted.
 */
export function selectCornerFrames<T extends SelectableFrame>(
  pool: T[],
  maxLevel: number,
  includeLow: boolean,
): T[] {
  const low = pool.filter((f) => f.view === "low");
  const level = pool.filter((f) => f.view !== "low");

  const withHeading = level.filter((f) => typeof f.heading_deg === "number");
  const mean = withHeading.length
    ? circularMean(withHeading.map((f) => f.heading_deg as number))
    : 0;
  const offset = (f: T) => norm((f.heading_deg as number) - mean + 180) - 180;
  const sorted = [...withHeading].sort((a, b) => offset(a) - offset(b));

  const best: T[] = [];
  let last = -Infinity;
  for (const f of sorted) {
    const o = offset(f);
    const held = best[best.length - 1];
    if (held && o - last <= SAME_DIRECTION_DEG) {
      if (isBetterFrame(f, held)) best[best.length - 1] = f;
    } else {
      best.push(f);
    }
    last = o;
  }
  // Frames without a heading can't be grouped; they only fill spare slots.
  const candidates = [...best, ...level.filter((f) => typeof f.heading_deg !== "number")];

  let chosen = candidates;
  if (candidates.length > maxLevel) {
    const keep = new Set(
      [...candidates]
        .sort((a, b) => (isBetterFrame(a, b) ? -1 : isBetterFrame(b, a) ? 1 : 0))
        .slice(0, maxLevel),
    );
    chosen = candidates.filter((f) => keep.has(f));
  }

  const bestLow = low.reduce<T | null>((b, f) => (!b || isBetterFrame(f, b) ? f : b), null);
  return includeLow && bestLow ? [...chosen, bestLow] : chosen;
}
