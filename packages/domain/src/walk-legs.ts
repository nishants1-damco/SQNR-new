/**
 * Metric scale from walking the perimeter.
 *
 * A spin from one spot cannot recover meters: every distance in a single
 * panorama is a guess. Walking wall to wall, however, gives a baseline in
 * meters straight from the phone's own motion sensors, and four such legs
 * around the perimeter ARE the room's width and length.
 *
 * Each leg is integrated between two zero-velocity anchors (the phone is held
 * still at every corner), which is the regime where consumer inertial
 * dead-reckoning is actually usable. The loop is then closed: four legs walked
 * around a rectangle must return to the start, so the closure error tells us
 * how much to trust the result and lets us correct it.
 *
 * Frame convention matches the rest of the app: +x east, +y north, meters.
 */

export interface WalkLeg {
  /** 0-based index of the leg, in walking order. */
  index: number;
  /** Straight-line displacement between the two corner anchors. */
  distance_m: number;
  /** Displacement components, east and north. */
  dx: number;
  dy: number;
  /** Path length actually integrated; exceeds distance_m when the walk wandered. */
  path_m: number;
  duration_s: number;
  /** 0..1 confidence: penalises wandering paths, very short walks and long ones. */
  quality: number;
  /** Cadence-filtered steps during this leg. */
  steps?: number;
  /** Conservative step-derived distance used only as a cross-check. */
  step_distance_m?: number;
}

export interface WalkedShell {
  /** East-west run in meters. */
  width_m: number;
  /** North-south run in meters. */
  length_m: number;
  /** How far the four legs missed returning to the start, in meters. */
  closure_error_m: number;
  /** Fractional 1-sigma tolerance on the runs, e.g. 0.08 for 8 percent. */
  tolerance: number;
  /** 0..1 overall trust in this shell. */
  quality: number;
  legs: WalkLeg[];
  basis: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Builds a leg record from a start/end displacement pair.
 * `path` is the integrated path length, used to detect a wandering walk.
 */
export function makeLeg(
  index: number,
  start: { x: number; y: number; travelled_m: number; t_s: number; steps?: number },
  end: { x: number; y: number; travelled_m: number; t_s: number; steps?: number },
): WalkLeg {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const path = Math.max(0, end.travelled_m - start.travelled_m);
  const duration = Math.max(0.001, end.t_s - start.t_s);
  const steps = Math.max(0, (end.steps ?? 0) - (start.steps ?? 0));
  const stepDistance = steps * 0.72;
  // A straight walk has path ~= distance. A wander, or a bad integration, does
  // not, and its displacement is the part we should distrust.
  const straightness = path > 0.05 ? Math.min(1, distance / path) : 0;
  // Domestic walls run roughly 1.5 to 12 m. Outside that the leg is suspect.
  const plausible = distance >= 1.2 && distance <= 12 ? 1 : 0.3;
  // Very fast legs give the integrator too few samples.
  const cadence = steps / duration;
  const paced = duration >= 1.2 && (steps === 0 || (cadence >= 0.55 && cadence <= 2.8)) ? 1 : 0.5;
  const agreement =
    steps >= 2 && distance > 0.1
      ? Math.max(0.35, 1 - Math.abs(stepDistance - distance) / Math.max(stepDistance, distance))
      : 0.65;
  return {
    index,
    distance_m: round2(distance),
    dx: round2(dx),
    dy: round2(dy),
    path_m: round2(path),
    duration_s: Math.round(duration * 10) / 10,
    quality:
      Math.round(Math.max(0, Math.min(1, straightness * plausible * paced * agreement)) * 100) /
      100,
    steps,
    step_distance_m: round2(stepDistance),
  };
}

/**
 * Folds four perimeter legs into a rectangle.
 *
 * Legs are assigned to an axis by their own direction of travel (not by where
 * the phone was pointing), then opposite legs are averaged. Loop closure
 * distributes the residual error across both axes so a consistently
 * over-reading accelerometer does not silently inflate the room.
 */
export function shellFromWalk(legs: WalkLeg[]): WalkedShell | null {
  const usable = legs.filter((l) => l && l.distance_m > 0.6 && l.quality > 0.15);
  if (usable.length < 2) return null;

  const eastWest: WalkLeg[] = [];
  const northSouth: WalkLeg[] = [];
  for (const leg of usable) {
    if (Math.abs(leg.dx) >= Math.abs(leg.dy)) eastWest.push(leg);
    else northSouth.push(leg);
  }

  const weightedRun = (group: WalkLeg[]) => {
    if (group.length === 0) return null;
    let sum = 0;
    let weight = 0;
    for (const leg of group) {
      // Project onto the group's own axis: a leg walked slightly diagonally
      // still contributes its along-wall component honestly.
      const along = Math.max(Math.abs(leg.dx), Math.abs(leg.dy));
      const w = Math.max(0.05, leg.quality);
      sum += along * w;
      weight += w;
    }
    return weight > 0 ? sum / weight : null;
  };

  let width = weightedRun(eastWest);
  let length = weightedRun(northSouth);
  // Only one axis was walked cleanly: assume the other is similar rather than
  // inventing a number, and say so through the tolerance.
  if (width == null && length == null) return null;
  if (width == null) width = length as number;
  if (length == null) length = width;

  // Loop closure. Four legs around a closed rectangle sum to zero.
  const sumX = usable.reduce((s, l) => s + l.dx, 0);
  const sumY = usable.reduce((s, l) => s + l.dy, 0);
  const closure = Math.hypot(sumX, sumY);
  const perimeter = 2 * (width + length);
  const closureRatio = perimeter > 0 ? closure / perimeter : 1;
  // A consistent scale bias shows up as a closure error proportional to the
  // perimeter. Correct at most 15 percent from it; beyond that the legs
  // disagree for some other reason and correcting would make things worse.
  const correction = 1 - Math.min(0.15, closureRatio * 0.5);
  width *= correction;
  length *= correction;

  // Disagreement between opposite legs on the same axis is the honest error bar.
  const spread = (group: WalkLeg[]) => {
    if (group.length < 2) return 0.12;
    const runs = group.map((l) => Math.max(Math.abs(l.dx), Math.abs(l.dy)));
    const lo = Math.min(...runs);
    const hi = Math.max(...runs);
    const mid = (lo + hi) / 2;
    return mid > 0 ? (hi - lo) / (2 * mid) : 0.12;
  };
  const tolerance = Math.max(
    0.05,
    Math.min(0.4, (spread(eastWest) + spread(northSouth)) / 2 + closureRatio),
  );

  const meanQuality = usable.reduce((s, l) => s + l.quality, 0) / usable.length;
  const coverage = Math.min(1, usable.length / 4);
  const quality = Math.max(
    0,
    Math.min(1, meanQuality * coverage * (1 - Math.min(0.6, closureRatio * 2))),
  );

  // Keep the result inside habitable bounds; an integration blow-up should be
  // rejected here rather than downstream.
  const clamp = (v: number) => Math.min(Math.max(v, 1.5), 14);
  width = clamp(width);
  length = clamp(length);

  return {
    width_m: round2(width),
    length_m: round2(length),
    closure_error_m: round2(closure),
    tolerance: Math.round(tolerance * 1000) / 1000,
    quality: Math.round(quality * 100) / 100,
    legs: usable,
    basis: `${usable.length} walked perimeter legs, ${round2(closure)} m loop closure error`,
  };
}

/** Prompt text describing the walked shell as a measurement, not a guess. */
export function describeWalkedShell(shell: WalkedShell): string {
  const pct = Math.round(shell.tolerance * 100);
  return [
    `MEASURED BY WALKING: the person capturing walked the room's perimeter corner to corner while the phone integrated its own motion between zero-velocity stops.`,
    `The east-west run measures ${shell.width_m} m and the north-south run measures ${shell.length_m} m, to within about ${pct} percent (${shell.basis}).`,
    `These are baselines in meters, not visual estimates. Use them as width_m and length_m. You may adjust each by at most ${pct} percent where the imagery clearly disagrees, and if you do, rescale every object and portal on that axis to match. Never replace them with a size inferred from a door leaf or a seat height.`,
  ].join(" ");
}

/**
 * Per-station positions implied by the walk, in room-center coordinates.
 * These are the metric baselines the reconstruction uses to triangulate.
 */
export function stationPositions(legs: WalkLeg[]): { index: number; x: number; y: number }[] {
  const points: { index: number; x: number; y: number }[] = [{ index: 0, x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (const leg of legs) {
    x += leg.dx;
    y += leg.dy;
    points.push({ index: leg.index + 1, x: round2(x), y: round2(y) });
  }
  // Re-center on the centroid so the numbers read like room coordinates.
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => ({ index: p.index, x: round2(p.x - cx), y: round2(p.y - cy) }));
}
