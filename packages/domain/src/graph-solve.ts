/**
 * A small graph SLAM back end.
 *
 * The capture gives us three things that each know something different about
 * the room, and none of which is trustworthy on its own:
 *
 *   - walked legs between standing positions (metric, but they drift)
 *   - compass bearings to fixed features seen from several positions
 *     (accurate in angle, no scale at all)
 *   - acoustic wall ranges (metric, noisy, sparse)
 *
 * Previously the walked legs were treated as truth and everything else was
 * placed from them, so one bad leg dragged the whole room with it. Here the
 * station positions and the landmark positions are solved together: a feature
 * confidently seen from three positions can push a drifted leg back into place
 * instead of inheriting its error.
 *
 * Levenberg-Marquardt over a few dozen parameters. The problem is tiny, so the
 * Jacobian is taken numerically and the normal equations are solved directly.
 *
 * Frame convention matches the rest of the app: +x east, +y north, meters,
 * compass bearings in degrees clockwise from north.
 */

export interface OdometryEdge {
  from: number;
  to: number;
  dx: number;
  dy: number;
  /** 0..1 confidence from the walk-leg quality score. */
  weight: number;
}

export interface BearingObservation {
  station: number;
  landmark: string;
  bearing_deg: number;
  /** 0..1 confidence reported by the vision pass. */
  weight: number;
}

export interface RangeObservation {
  station: number;
  bearing_deg: number;
  distance_m: number;
  weight: number;
}

export interface SolveInput {
  /** Initial station guesses, index-aligned. Station 0 anchors the frame. */
  stations: { x: number; y: number }[];
  odometry: OdometryEdge[];
  bearings: BearingObservation[];
  ranges?: RangeObservation[];
  /** Stations that should coincide, e.g. a capture that returned to the start. */
  closure?: { from: number; to: number; tolerance_m: number } | null;
}

export interface SolvedGraph {
  stations: { index: number; x: number; y: number }[];
  landmarks: { id: string; x: number; y: number; sightings: number }[];
  /** Mean absolute bearing miss after the solve, in degrees. */
  bearing_residual_deg: number;
  /** Mean odometry disagreement after the solve, in meters. */
  odometry_residual_m: number;
  closure_error_m: number;
  /** 0..1. Below ~0.25 the station layout cannot resolve the room. */
  conditioning: number;
  converged: boolean;
  iterations: number;
  /** Plain-language account of what the solve could and could not settle. */
  basis: string;
}

const DEG = Math.PI / 180;
const BEARING_SIGMA_DEG = 4;
const ODOM_SIGMA_M = 0.35;
const RANGE_SIGMA_M = 0.6;

const round2 = (v: number) => Math.round(v * 100) / 100;

function wrapDeg(d: number) {
  return ((d + 540) % 360) - 180;
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearingBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  return (((Math.atan2(b.x - a.x, b.y - a.y) / DEG) % 360) + 360) % 360;
}

/**
 * Where two bearing rays cross. Returns null when the rays are near parallel,
 * which is exactly the degenerate case a two-station capture suffers from for
 * anything lying along the baseline.
 */
export function intersectBearings(
  a: { x: number; y: number },
  bearingA: number,
  b: { x: number; y: number },
  bearingB: number,
): { x: number; y: number } | null {
  const ax = Math.sin(bearingA * DEG);
  const ay = Math.cos(bearingA * DEG);
  const bx = Math.sin(bearingB * DEG);
  const by = Math.cos(bearingB * DEG);
  const det = ax * -by - -bx * ay;
  // Rays within ~8 degrees of parallel carry no usable depth.
  if (Math.abs(det) < 0.14) return null;
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const t = (rx * -by - -bx * ry) / det;
  if (t <= 0.15 || t > 40) return null;
  const p = { x: a.x + ax * t, y: a.y + ay * t };
  // The point must also lie forward of the second station.
  const u = (p.x - b.x) * bx + (p.y - b.y) * by;
  if (u <= 0.15) return null;
  return p;
}

/**
 * How well the station layout can resolve the floor plane.
 *
 * Two stations, or three in a line, give a single baseline direction: anything
 * lying along that direction has almost no parallax and its distance is a
 * guess. The measure below is the spread perpendicular to the best-fit line
 * through the stations, relative to the spread along it.
 */
export function stationConditioning(stations: { x: number; y: number }[]): {
  score: number;
  spread_m: number;
  perpendicular_m: number;
  reason: string;
} {
  if (stations.length < 2) {
    return { score: 0, spread_m: 0, perpendicular_m: 0, reason: "only one viewpoint" };
  }
  const n = stations.length;
  const cx = stations.reduce((s, p) => s + p.x, 0) / n;
  const cy = stations.reduce((s, p) => s + p.y, 0) / n;
  // Principal axis of the station cloud.
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of stations) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const major = Math.sqrt(Math.max(0, tr / 2 + Math.sqrt(disc)) / n);
  const minor = Math.sqrt(Math.max(0, tr / 2 - Math.sqrt(disc)) / n);

  if (major < 0.4) {
    return {
      score: 0,
      spread_m: round2(major),
      perpendicular_m: round2(minor),
      reason: "the viewpoints are all within half a meter of each other",
    };
  }
  // A healthy triangle has minor/major somewhere near 0.3 or better.
  const ratio = minor / major;
  const spreadTerm = Math.min(1, major / 1.5);
  const shapeTerm = Math.min(1, ratio / 0.3);
  const countTerm = Math.min(1, (n - 1) / 2);
  const score = Math.max(0, Math.min(1, spreadTerm * shapeTerm * countTerm));
  const reason =
    ratio < 0.12
      ? "the viewpoints lie almost in a straight line, so depth along that line is unresolved"
      : score > 0.6
        ? "the viewpoints form a usable triangle"
        : "the viewpoint spread is workable but thin";
  return {
    score: Math.round(score * 100) / 100,
    spread_m: round2(major),
    perpendicular_m: round2(minor),
    reason,
  };
}

/** Solves the dense normal equations by Gaussian elimination with pivoting. */
function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (
        Math.abs((m[r] as number[])[col] as number) >
        Math.abs((m[pivot] as number[])[col] as number)
      )
        pivot = r;
    }
    const pRow = m[pivot] as number[];
    if (Math.abs(pRow[col] as number) < 1e-12) return null;
    if (pivot !== col) {
      m[pivot] = m[col] as number[];
      m[col] = pRow;
    }
    const cRow = m[col] as number[];
    const d = cRow[col] as number;
    for (let c = col; c <= n; c++) cRow[c] = (cRow[c] as number) / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r] as number[];
      const f = row[col] as number;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (cRow[c] as number);
    }
  }
  return m.map((row) => (row as number[])[n] as number);
}

function solveGraphOnce(input: SolveInput): SolvedGraph | null {
  const stationCount = input.stations.length;
  if (stationCount < 2) return null;

  // Only landmarks seen from two or more distinct stations carry depth.
  const byLandmark = new Map<string, BearingObservation[]>();
  for (const b of input.bearings) {
    if (!Number.isFinite(b.bearing_deg) || b.station < 0 || b.station >= stationCount) continue;
    const list = byLandmark.get(b.landmark) ?? [];
    list.push(b);
    byLandmark.set(b.landmark, list);
  }
  const landmarkIds: string[] = [];
  const usableBearings: BearingObservation[] = [];
  for (const [id, list] of byLandmark) {
    const stations = new Set(list.map((l) => l.station));
    if (stations.size < 2) continue;
    landmarkIds.push(id);
    usableBearings.push(...list);
  }

  // Parameter vector: station 1..n-1 (station 0 anchors the frame, and the
  // compass fixes rotation, so there is no gauge freedom left), then landmarks.
  const stationParam = (i: number) => (i - 1) * 2;
  const landmarkParam = (k: number) => (stationCount - 1) * 2 + k * 2;
  const paramCount = (stationCount - 1) * 2 + landmarkIds.length * 2;
  if (paramCount === 0) return null;

  const p = new Array<number>(paramCount).fill(0);
  for (let i = 1; i < stationCount; i++) {
    const s = input.stations[i] as { x: number; y: number };
    p[stationParam(i)] = s.x - (input.stations[0] as { x: number; y: number }).x;
    p[stationParam(i) + 1] = s.y - (input.stations[0] as { x: number; y: number }).y;
  }

  const stationAt = (params: number[], i: number) =>
    i === 0
      ? { x: 0, y: 0 }
      : { x: params[stationParam(i)] as number, y: params[stationParam(i) + 1] as number };

  // Initial landmark guesses by intersecting the two most divergent rays.
  landmarkIds.forEach((id, k) => {
    const list = byLandmark.get(id) as BearingObservation[];
    let best: { x: number; y: number } | null = null;
    let bestSpread = 0;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const oa = list[a] as BearingObservation;
        const ob = list[b] as BearingObservation;
        if (oa.station === ob.station) continue;
        const spread = Math.abs(wrapDeg(oa.bearing_deg - ob.bearing_deg));
        if (spread <= bestSpread) continue;
        const hit = intersectBearings(
          stationAt(p, oa.station),
          oa.bearing_deg,
          stationAt(p, ob.station),
          ob.bearing_deg,
        );
        if (hit) {
          best = hit;
          bestSpread = spread;
        }
      }
    }
    if (!best) {
      // No usable crossing: drop it three meters out along the first bearing
      // and let the solve decide, rather than seeding it at the origin where
      // every landmark would pile into one corner.
      const first = (byLandmark.get(id) as BearingObservation[])[0] as BearingObservation;
      const s = stationAt(p, first.station);
      best = {
        x: s.x + Math.sin(first.bearing_deg * DEG) * 3,
        y: s.y + Math.cos(first.bearing_deg * DEG) * 3,
      };
    }
    p[landmarkParam(k)] = best.x;
    p[landmarkParam(k) + 1] = best.y;
  });

  const landmarkIndex = new Map(landmarkIds.map((id, k) => [id, k]));
  const ranges = (input.ranges ?? []).filter(
    (r) => r.station >= 0 && r.station < stationCount && r.distance_m > 0.3 && r.distance_m < 20,
  );

  const residuals = (params: number[]): number[] => {
    const out: number[] = [];
    for (const b of usableBearings) {
      const k = landmarkIndex.get(b.landmark);
      if (k == null) continue;
      const s = stationAt(params, b.station);
      const l = {
        x: params[landmarkParam(k)] as number,
        y: params[landmarkParam(k) + 1] as number,
      };
      const predicted = bearingBetween(s, l);
      const w = Math.max(0.1, Math.min(1, b.weight));
      out.push((wrapDeg(predicted - b.bearing_deg) / BEARING_SIGMA_DEG) * w);
    }
    for (const e of input.odometry) {
      if (e.from < 0 || e.to < 0 || e.from >= stationCount || e.to >= stationCount) continue;
      const a = stationAt(params, e.from);
      const b = stationAt(params, e.to);
      const w = Math.max(0.1, Math.min(1, e.weight));
      out.push(((b.x - a.x - e.dx) / ODOM_SIGMA_M) * w);
      out.push(((b.y - a.y - e.dy) / ODOM_SIGMA_M) * w);
    }
    for (const r of ranges) {
      // A wall range says: the surface straight ahead is this far away. It
      // pulls on any landmark sitting close to that bearing from that station.
      const s = stationAt(params, r.station);
      let closest: { k: number; delta: number } | null = null;
      landmarkIds.forEach((_, k) => {
        const l = {
          x: params[landmarkParam(k)] as number,
          y: params[landmarkParam(k) + 1] as number,
        };
        const delta = Math.abs(wrapDeg(bearingBetween(s, l) - r.bearing_deg));
        if (delta < 18 && (!closest || delta < closest.delta)) closest = { k, delta };
      });
      if (!closest) continue;
      const pick = closest as { k: number; delta: number };
      const l = {
        x: params[landmarkParam(pick.k)] as number,
        y: params[landmarkParam(pick.k) + 1] as number,
      };
      const dist = Math.hypot(l.x - s.x, l.y - s.y);
      const w = Math.max(0.1, Math.min(1, r.weight)) * 0.5;
      out.push(((dist - r.distance_m) / RANGE_SIGMA_M) * w);
    }
    const closure = input.closure;
    if (closure && closure.from < stationCount && closure.to < stationCount) {
      const a = stationAt(params, closure.from);
      const b = stationAt(params, closure.to);
      const sigma = Math.max(0.2, closure.tolerance_m);
      out.push((b.x - a.x) / sigma);
      out.push((b.y - a.y) / sigma);
    }
    return out;
  };

  const cost = (params: number[]) => residuals(params).reduce((s, r) => s + r * r, 0);

  let current = [...p];
  let currentCost = cost(current);
  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < 60; iter++) {
    iterations = iter + 1;
    const r0 = residuals(current);
    const m = r0.length;
    if (m === 0) break;

    // Numeric Jacobian. Forty-odd parameters over sixty-odd residuals is a
    // few thousand cheap evaluations per iteration, which is nothing here.
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(paramCount).fill(0));
    const h = 1e-4;
    for (let c = 0; c < paramCount; c++) {
      const bumped = [...current];
      bumped[c] = (bumped[c] as number) + h;
      const r1 = residuals(bumped);
      for (let i = 0; i < m; i++) {
        (J[i] as number[])[c] = (((r1[i] as number) ?? 0) - ((r0[i] as number) ?? 0)) / h;
      }
    }

    const JtJ: number[][] = Array.from({ length: paramCount }, () =>
      new Array<number>(paramCount).fill(0),
    );
    const Jtr = new Array<number>(paramCount).fill(0);
    for (let i = 0; i < m; i++) {
      const row = J[i] as number[];
      const ri = r0[i] as number;
      for (let a = 0; a < paramCount; a++) {
        const va = row[a] as number;
        if (va === 0) continue;
        Jtr[a] = (Jtr[a] as number) + va * ri;
        const dst = JtJ[a] as number[];
        for (let b = a; b < paramCount; b++) {
          dst[b] = (dst[b] as number) + va * (row[b] as number);
        }
      }
    }
    for (let a = 0; a < paramCount; a++) {
      for (let b = 0; b < a; b++) {
        (JtJ[a] as number[])[b] = (JtJ[b] as number[])[a] as number;
      }
    }

    let stepped = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const damped = JtJ.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (1 + v) : v)));
      const delta = solveDense(
        damped,
        Jtr.map((v) => -v),
      );
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const candidate = current.map((v, i) => v + ((delta[i] as number) ?? 0));
      const candidateCost = cost(candidate);
      if (candidateCost < currentCost) {
        const improvement = currentCost - candidateCost;
        current = candidate;
        currentCost = candidateCost;
        lambda = Math.max(1e-6, lambda / 3);
        stepped = true;
        if (improvement < 1e-6 * Math.max(1, currentCost)) converged = true;
        break;
      }
      lambda *= 10;
    }
    if (!stepped || converged) {
      converged = converged || !stepped;
      break;
    }
  }

  // Report residuals in their natural units rather than the weighted ones.
  const finalStations = Array.from({ length: stationCount }, (_, i) => ({
    index: i,
    ...stationAt(current, i),
  }));
  const finalLandmarks = landmarkIds.map((id, k) => ({
    id,
    x: current[landmarkParam(k)] as number,
    y: current[landmarkParam(k) + 1] as number,
    sightings: (byLandmark.get(id) as BearingObservation[]).length,
  }));

  let bearingMiss = 0;
  for (const b of usableBearings) {
    const k = landmarkIndex.get(b.landmark);
    if (k == null) continue;
    const s = finalStations[b.station] as { x: number; y: number };
    const l = finalLandmarks[k] as { x: number; y: number };
    bearingMiss += Math.abs(wrapDeg(bearingBetween(s, l) - b.bearing_deg));
  }
  bearingMiss = usableBearings.length ? bearingMiss / usableBearings.length : 0;

  let odomMiss = 0;
  let odomCount = 0;
  for (const e of input.odometry) {
    const a = finalStations[e.from];
    const b = finalStations[e.to];
    if (!a || !b) continue;
    odomMiss += Math.hypot(b.x - a.x - e.dx, b.y - a.y - e.dy);
    odomCount++;
  }
  odomMiss = odomCount ? odomMiss / odomCount : 0;

  const closure = input.closure;
  const closureError =
    closure && finalStations[closure.from] && finalStations[closure.to]
      ? Math.hypot(
          (finalStations[closure.to] as { x: number }).x -
            (finalStations[closure.from] as { x: number }).x,
          (finalStations[closure.to] as { y: number }).y -
            (finalStations[closure.from] as { y: number }).y,
        )
      : 0;

  const cond = stationConditioning(finalStations);

  return {
    stations: finalStations.map((s) => ({ index: s.index, x: round2(s.x), y: round2(s.y) })),
    landmarks: finalLandmarks.map((l) => ({
      id: l.id,
      x: round2(l.x),
      y: round2(l.y),
      sightings: l.sightings,
    })),
    bearing_residual_deg: Math.round(bearingMiss * 10) / 10,
    odometry_residual_m: round2(odomMiss),
    closure_error_m: round2(closureError),
    conditioning: cond.score,
    converged,
    iterations,
    basis: `${stationCount} viewpoints, ${finalLandmarks.length} shared landmarks, ${usableBearings.length} bearings; ${cond.reason}`,
  };
}

/** Angular miss of each bearing against a solved layout, in degrees. */
function bearingMisses(solved: SolvedGraph, bearings: BearingObservation[]): number[] {
  const stationAt = new Map(solved.stations.map((s) => [s.index, s]));
  const landmarkAt = new Map(solved.landmarks.map((l) => [l.id, l]));
  return bearings.map((b) => {
    const s = stationAt.get(b.station);
    const l = landmarkAt.get(b.landmark);
    if (!s || !l) return 0;
    return Math.abs(wrapDeg(bearingBetween(s, l) - b.bearing_deg));
  });
}

/**
 * Solve, then throw away the sightings that plainly disagree and solve again.
 *
 * A single mislabeled feature (the same name pinned to two different things in
 * two frames) drags every station with it. Rejecting by residual is what stops
 * one bad correspondence from being averaged into the room instead of dropped.
 */
export function solveGraph(input: SolveInput): SolvedGraph | null {
  const first = solveGraphOnce(input);
  if (!first) return null;

  const misses = bearingMisses(first, input.bearings);
  if (input.bearings.length < 6) return first;

  const sorted = [...misses].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const cutoff = Math.max(8, median * 2.5);
  const kept = input.bearings.filter((_, i) => (misses[i] as number) <= cutoff);
  // Only worth a second pass if we dropped something but kept the bulk of the
  // evidence, and still have two viewpoints looking at a shared feature.
  if (kept.length === input.bearings.length) return first;
  if (kept.length < Math.max(4, Math.ceil(input.bearings.length * 0.6))) return first;
  const stillShared = new Set<string>();
  const seen = new Map<string, Set<number>>();
  for (const b of kept) {
    const set = seen.get(b.landmark) ?? new Set<number>();
    set.add(b.station);
    seen.set(b.landmark, set);
    if (set.size >= 2) stillShared.add(b.landmark);
  }
  if (stillShared.size < 2) return first;

  const second = solveGraphOnce({ ...input, bearings: kept });
  if (!second) return first;
  if (second.bearing_residual_deg > first.bearing_residual_deg) return first;
  const dropped = input.bearings.length - kept.length;
  return {
    ...second,
    basis: `${second.basis}; ${dropped} disagreeing sighting${dropped === 1 ? "" : "s"} rejected`,
  };
}

/**
 * Room shell implied by the solved landmarks.
 *
 * Landmarks are wall features by construction (window corners, arch edges,
 * wall junctions), so their bounding box is the room's inner shell, give or
 * take the few centimeters the model puts them off the surface.
 */
export function shellFromSolve(solved: SolvedGraph): {
  width_m: number;
  length_m: number;
  center_x: number;
  center_y: number;
  quality: number;
} | null {
  const pts = solved.landmarks.filter((l) => l.sightings >= 2);
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  // Trim the single most extreme point per side so one badly triangulated
  // landmark cannot inflate the room into a skating rink.
  const trimmed = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length >= 6)
      return { lo: sorted[1] as number, hi: sorted[sorted.length - 2] as number };
    return { lo: sorted[0] as number, hi: sorted[sorted.length - 1] as number };
  };
  const x = trimmed(xs);
  const y = trimmed(ys);
  const width = x.hi - x.lo;
  const length = y.hi - y.lo;
  if (!(width > 1.2 && length > 1.2 && width < 25 && length < 25)) return null;
  const residualPenalty = Math.max(0, 1 - solved.bearing_residual_deg / 12);
  const quality = Math.max(
    0,
    Math.min(1, solved.conditioning * residualPenalty * Math.min(1, pts.length / 6)),
  );
  return {
    width_m: round2(width),
    length_m: round2(length),
    center_x: round2((x.lo + x.hi) / 2),
    center_y: round2((y.lo + y.hi) / 2),
    quality: Math.round(quality * 100) / 100,
  };
}
