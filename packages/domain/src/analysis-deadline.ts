// Single source of truth for "how long may an analysis stay in processing".
//
// The server stamps `analysis_notes.deadline_at` when it claims a scan, sized
// to the provider that will run it: a cloud (Claude) run finishes in minutes,
// a CPU-only local (Ollama) run can take hours. Everything that asks "is this
// run stuck?" — the space page's retry banner, the catalog's stalled-scan
// sweep, the client's post-disconnect poller and the server's re-claim gate —
// reads that one deadline instead of carrying its own hardcoded threshold.
//
// Pure module: no server imports, safe in the browser and in tests.

/**
 * Wall-clock allowance for a cloud (Claude) analysis run. A full run —
 * per-viewpoint detection, zoom-in verification, reconstruction and review,
 * each at high effort — has been measured at ~15 minutes, so allow double.
 */
export const CLOUD_ANALYSIS_DEADLINE_MS = 30 * 60 * 1000;

/** Wall-clock allowance for a local (Ollama, often CPU-only) analysis run. */
export const LOCAL_ANALYSIS_DEADLINE_MS = 3 * 60 * 60 * 1000;

export function analysisDeadlineFor(provider: string, now = Date.now()): string {
  const budget = provider === "ollama" ? LOCAL_ANALYSIS_DEADLINE_MS : CLOUD_ANALYSIS_DEADLINE_MS;
  return new Date(now + budget).toISOString();
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Epoch ms after which a processing run counts as stuck. Rows written before
 * `deadline_at` existed fall back to `started_at` (or the row's `created_at`)
 * plus the cloud allowance.
 */
export function analysisDeadlineMs(notes: unknown, createdAt?: string | null): number {
  const n = (notes ?? {}) as Record<string, unknown>;
  const deadline = parseTime(n["deadline_at"]);
  if (deadline != null) return deadline;
  const started = parseTime(n["started_at"]) ?? parseTime(createdAt) ?? 0;
  return started + CLOUD_ANALYSIS_DEADLINE_MS;
}

/** True when a scan is in `processing` but its run has outlived its deadline. */
export function isAnalysisStale(
  scan: { status: string; analysis_notes?: unknown; created_at?: string | null },
  now = Date.now(),
): boolean {
  return (
    scan.status === "processing" && now > analysisDeadlineMs(scan.analysis_notes, scan.created_at)
  );
}
