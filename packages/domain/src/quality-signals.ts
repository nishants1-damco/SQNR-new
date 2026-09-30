// Purely functional quality scorer used by the capture UI and the server
// analysis prompt. Two independent scores in [0, 1]:
//
//   - coverage: how completely the 360° ring around a station was sampled
//   - stability: how steady the pose was between frames (higher = better)
//
// These are heuristics on top of what the capture flow already tracks:
// per-frame heading and (optional) inertial pose. Kept pure so tests
// don't need a DOM.

const BIN_DEG = 22.5;
const BIN_COUNT = 16;

export interface QualitySignalInput {
  /** Per-frame headings in degrees, 0..360. Missing values are ignored. */
  headings: (number | null)[];
  /** Per-frame inertial displacement in meters, if any. */
  poseDrift?: (number | null)[];
  /** How many bins we intend to fill; defaults to a full 360° ring. */
  targetBins?: number;
}

export interface QualitySignals {
  coverage: number;
  stability: number;
  filledBins: number;
  totalBins: number;
}

function headingBin(deg: number): number {
  return Math.floor((((deg % 360) + 360) % 360) / BIN_DEG) % BIN_COUNT;
}

/**
 * Compute both scores. `coverage` is (unique bins hit / target bins).
 * `stability` starts at 1.0 and decays with median pose drift (linear
 * penalty up to 0.5 m of drift, then floored at 0).
 */
export function computeQualitySignals(input: QualitySignalInput): QualitySignals {
  const target = input.targetBins ?? BIN_COUNT;
  const filled = new Set<number>();
  for (const h of input.headings) {
    if (h == null || !Number.isFinite(h)) continue;
    filled.add(headingBin(h));
  }
  const coverage = target > 0 ? Math.min(1, filled.size / target) : 0;

  const drifts = (input.poseDrift ?? [])
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  let stability = 1;
  if (drifts.length > 0) {
    const median = drifts[Math.floor(drifts.length / 2)]!;
    // Anything ≥ 0.5 m of median drift makes the frame set effectively
    // unusable for stitching.
    stability = Math.max(0, 1 - median / 0.5);
  }

  return { coverage, stability, filledBins: filled.size, totalBins: target };
}

/** Human-readable rollup for UI. */
export function qualityLabel(signals: QualitySignals): "poor" | "ok" | "good" {
  // Coverage dominates: a sparse ring should read "poor" even before any
  // pose/drift data exists (stability defaults to a perfect 1.0 until we
  // have drift samples, so it must not be able to mask low coverage).
  const score = 0.8 * signals.coverage + 0.2 * signals.stability;
  if (score < 0.4) return "poor";
  if (score < 0.75) return "ok";
  return "good";
}
