// A record of every captured frame removed from a scan, and why, kept in
// `scans.analysis_notes.frame_removals`. Frames used to disappear without a
// trace (the privacy screen deleted them and nothing said so); now the Frames
// tab can explain each gap.
//
// Pure module: safe in the browser and in tests.

export type RemovalReason = "people" | "manual";
/** Who removed it: the automatic purge after analysis, the Frames tab sweep, or the user. */
export type RemovalSource = "analysis" | "privacy-sweep" | "manual";

export interface RemovedFrame {
  idx: number | null;
  heading_deg: number | null;
  station: number | null;
}

export interface FrameRemoval {
  at: string;
  reason: RemovalReason;
  source: RemovalSource;
  frames: RemovedFrame[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** What to remember about a `scan_photos` row that is being removed. */
export function removedFrame(photo: {
  idx?: unknown;
  heading_deg?: unknown;
  sensor_payload?: unknown;
}): RemovedFrame {
  const payload = (photo.sensor_payload ?? {}) as Record<string, unknown>;
  return {
    idx: num(photo.idx),
    heading_deg: num(photo.heading_deg),
    station: num(payload["station"]),
  };
}

export function readRemovals(notes: unknown): FrameRemoval[] {
  const list = (notes as { frame_removals?: unknown } | null)?.frame_removals;
  return Array.isArray(list) ? (list as FrameRemoval[]) : [];
}

/** `analysis_notes` with one more removal recorded. */
export function appendRemoval(notes: unknown, removal: FrameRemoval): Record<string, unknown> {
  const base = (notes && typeof notes === "object" ? notes : {}) as Record<string, unknown>;
  return { ...base, frame_removals: [...readRemovals(notes), removal] };
}

export interface RemovalSummary {
  people: number;
  manual: number;
  frames: (RemovedFrame & Pick<FrameRemoval, "at" | "reason" | "source">)[];
  /** Frame numbers missing from the capture with no recorded removal (removed before recording began). */
  unrecorded: number[];
}

/**
 * Every recorded removal, newest first, plus the frame numbers that are
 * missing from `storedIdx` without a record.
 */
export function summarizeRemovals(notes: unknown, storedIdx: number[]): RemovalSummary {
  const removals = readRemovals(notes);
  const frames = removals
    .flatMap((r) => r.frames.map((f) => ({ ...f, at: r.at, reason: r.reason, source: r.source })))
    .sort((a, b) => b.at.localeCompare(a.at));
  const recorded = new Set(frames.map((f) => f.idx).filter((i): i is number => i != null));
  const stored = new Set(storedIdx);
  const highest = Math.max(-1, ...storedIdx, ...recorded);
  const unrecorded: number[] = [];
  for (let i = 0; i <= highest; i++) if (!stored.has(i) && !recorded.has(i)) unrecorded.push(i);
  return {
    people: frames.filter((f) => f.reason === "people").length,
    manual: frames.filter((f) => f.reason === "manual").length,
    frames,
    unrecorded,
  };
}
