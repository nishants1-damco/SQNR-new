// The on-demand privacy sweep, ported from `purgePeopleFrames`
// (`src/lib/space.functions.ts`): screen every stored frame of a scan for
// people and delete the ones that contain any. Now a job: the rows go in one
// transaction with the removal record, and the files through the outbox.
//
// Unlike the screening inside an analysis, a failed model call fails the
// job (and it retries) instead of quietly reporting "no people found".
import { appendRemoval, removedFrame } from "@spatial/domain/frame-removals";
import type { BlobStore } from "@spatial/storage";
import { sql } from "drizzle-orm";
import type { LlmProvider } from "./llm/types";
import { UsageTracker, type UsageSummary } from "./llm/usage";
import type { PipelineLogger } from "./logger";
import { createPasses } from "./passes";
import type { AnalysisStore } from "./store";

export interface PrivacyPurgeResult {
  scanned: number;
  removed: number;
  usage: UsageSummary;
}

export async function runPrivacyPurge(
  deps: { store: AnalysisStore; blobs: BlobStore; provider: LlmProvider; logger: PipelineLogger },
  job: { scanId: string; userId: string; requestedAt: string },
): Promise<PrivacyPurgeResult | { skipped: string }> {
  const { store } = deps;
  const db = store.db;
  const owned = await db.execute<{ id: string }>(
    sql`SELECT id FROM scans WHERE id = ${job.scanId} AND user_id = ${job.userId}`,
  );
  if (!owned.rows[0]) return { skipped: "scan deleted" };

  const photos = await store.loadPhotos(job.scanId);
  const usage = new UsageTracker();
  const passes = createPasses({
    provider: deps.provider,
    blobs: deps.blobs,
    usage,
    logger: deps.logger,
  });
  const doomed = await passes.screenAllFramesForPeople(
    photos.map((p) => ({ path: p.storage_path })),
    { strict: true },
  );

  const summary = usage.summary();
  const removed = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ analysis_notes: Record<string, unknown> }>(
      sql`SELECT analysis_notes FROM scans WHERE id = ${job.scanId} FOR UPDATE`,
    );
    const scan = rows[0];
    if (!scan) return 0;
    const gone = doomed.length ? await store.deletePhotos(tx, job.scanId, doomed) : [];
    let notes = scan.analysis_notes ?? {};
    if (gone.length) {
      notes = appendRemoval(notes, {
        at: new Date().toISOString(),
        reason: "people",
        source: "privacy-sweep",
        frames: gone.map(removedFrame),
      });
    }
    notes = {
      ...notes,
      privacy_sweep: {
        status: "done",
        requested_at: job.requestedAt,
        finished_at: new Date().toISOString(),
        scanned: photos.length,
        removed: gone.length,
        estimated_cost_usd: summary.estimated_cost_usd,
      },
    };
    await tx.execute(
      sql`UPDATE scans SET analysis_notes = ${JSON.stringify(notes)}::jsonb WHERE id = ${job.scanId}`,
    );
    return gone.length;
  });
  deps.logger.info(
    { scanId: job.scanId, scanned: photos.length, removed, cost: summary.estimated_cost_usd },
    "privacy sweep done",
  );
  return { scanned: photos.length, removed, usage: summary };
}

/** Records that a sweep gave up, so the space page stops showing it as pending. */
export async function failPrivacyPurge(
  store: AnalysisStore,
  job: { scanId: string; requestedAt: string },
  message: string,
): Promise<void> {
  await store.db.execute(sql`
    UPDATE scans SET analysis_notes = analysis_notes || ${JSON.stringify({
      privacy_sweep: {
        status: "failed",
        requested_at: job.requestedAt,
        finished_at: new Date().toISOString(),
        error: message.slice(0, 500),
      },
    })}::jsonb
    WHERE id = ${job.scanId}`);
}
