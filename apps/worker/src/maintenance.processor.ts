// Scheduled housekeeping (plan §9.1). A BullMQ job scheduler fires each task
// once per interval across all worker replicas, not once per replica.
//   * upload-sessions.sweep: upload sessions nobody completed are deleted, and
//     whatever was uploaded under their keys is queued for deletion.
//   * scans.sweep-stalled: scans stuck in `processing` past their run's
//     deadline are failed (the original app's browser-driven
//     `sweepStalledScans`), and their runs marked timed out. Same deadline
//     rule, from @spatial/domain/analysis-deadline.
//   * checkpoints.sweep: stage outputs of runs that ended a week ago.
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import {
  type DatabaseHandle,
  enqueueOutbox,
  OUTBOX_TOPICS,
  type UploadSessionFile,
} from "@spatial/db";
import { isAnalysisStale } from "@spatial/domain/analysis-deadline";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE, Queues } from "./queues";
import { DATABASE_HANDLE, WORKER_CONFIG } from "./tokens";

export const MAINTENANCE_TASKS = {
  sweepUploadSessions: "upload-sessions.sweep",
  sweepStalledScans: "scans.sweep-stalled",
  sweepCheckpoints: "checkpoints.sweep",
} as const;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const STALLED_EVERY_MS = 5 * 60 * 1000;
const CHECKPOINTS_EVERY_MS = 6 * 60 * 60 * 1000;
const STALLED_MESSAGE =
  "Analysis timed out (the worker exceeded its time budget). Retry from the space page.";
/** Matches the API's completion grace period: sessions older than this can't be completed. */
const ABANDONED_AFTER = sql`interval '1 hour'`;

@Injectable()
export class MaintenanceProcessor extends QueueProcessor implements OnApplicationBootstrap {
  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly queues: Queues,
    @InjectPinoLogger(MaintenanceProcessor.name) logger: PinoLogger,
  ) {
    super(QUEUE.maintenance, config, 1, logger);
  }

  override async onApplicationBootstrap() {
    super.onApplicationBootstrap();
    const queue = this.queues.get(QUEUE.maintenance);
    for (const [name, every] of [
      [MAINTENANCE_TASKS.sweepUploadSessions, SWEEP_EVERY_MS],
      [MAINTENANCE_TASKS.sweepStalledScans, STALLED_EVERY_MS],
      [MAINTENANCE_TASKS.sweepCheckpoints, CHECKPOINTS_EVERY_MS],
    ] as const) {
      await queue.upsertJobScheduler(name, { every }, { name });
    }
  }

  protected handle(job: Job) {
    if (job.name === MAINTENANCE_TASKS.sweepUploadSessions) return this.sweepUploadSessions();
    if (job.name === MAINTENANCE_TASKS.sweepStalledScans) return this.sweepStalledScans();
    if (job.name === MAINTENANCE_TASKS.sweepCheckpoints) return this.sweepCheckpoints();
    throw new Error(`Unknown maintenance job ${job.name}`);
  }

  /**
   * Fails scans whose run outlived its deadline (`analysis_notes.deadline_at`,
   * stamped when the API queued it and sized to the provider). BullMQ's own
   * stalled-job handling retries runs whose worker died; this is the safety
   * net for runs that can never finish, so no space stays in "processing".
   */
  async sweepStalledScans(now = Date.now()): Promise<{ swept: number }> {
    const { rows } = await this.database.db.execute<{
      id: string;
      analysis_notes: Record<string, unknown>;
      created_at: string;
    }>(sql`
      SELECT id, analysis_notes, to_jsonb(created_at) #>> '{}' AS created_at
      FROM scans WHERE status = 'processing'
      ORDER BY updated_at LIMIT 1000`);
    let swept = 0;
    for (const row of rows) {
      if (!isAnalysisStale({ ...row, status: "processing" }, now)) continue;
      const notes = row.analysis_notes ?? {};
      const analysisId = typeof notes["analysis_id"] === "string" ? notes["analysis_id"] : null;
      const startedAt = typeof notes["started_at"] === "string" ? notes["started_at"] : null;
      await this.database.db.transaction(async (tx) => {
        // Don't clobber a run that re-claimed the scan since we read it.
        const { rowCount } = await tx.execute(sql`
          UPDATE scans SET status = 'failed',
            analysis_notes = analysis_notes || jsonb_build_object(
              'failed_at', now(),
              'error', coalesce(analysis_notes->>'error', ${STALLED_MESSAGE}::text),
              'swept', true,
              'stage', 'failed')
          WHERE id = ${row.id} AND status = 'processing'
            AND ${startedAt === null ? sql`analysis_notes->>'started_at' IS NULL` : sql`analysis_notes->>'started_at' = ${startedAt}`}`);
        if (!rowCount) return;
        swept++;
        if (analysisId) {
          await tx.execute(sql`
            UPDATE scan_analyses SET status = 'timed_out', finished_at = now(),
              duration_ms = (extract(epoch FROM now() - started_at) * 1000)::int,
              error_code = 'timed_out', error_message = ${STALLED_MESSAGE}
            WHERE id::text = ${analysisId} AND status IN ('queued', 'running')`);
        }
      });
    }
    if (swept) this.logger.info({ swept }, "failed stalled analyses");
    return { swept };
  }

  /** Checkpoints of runs that ended more than a week ago (successful runs clear their own). */
  async sweepCheckpoints(): Promise<{ deleted: number }> {
    const { rowCount } = await this.database.db.execute(sql`
      DELETE FROM analysis_checkpoints c USING scan_analyses a
      WHERE c.analysis_id = a.id AND a.status NOT IN ('queued', 'running')
        AND a.finished_at < now() - interval '7 days'`);
    return { deleted: rowCount ?? 0 };
  }

  async sweepUploadSessions(): Promise<{ sessions: number }> {
    return this.database.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ files: UploadSessionFile[] }>(sql`
        DELETE FROM upload_sessions
        WHERE id IN (
          SELECT id FROM upload_sessions
          WHERE completed_at IS NULL AND expires_at < now() - ${ABANDONED_AFTER}
          LIMIT 1000 FOR UPDATE SKIP LOCKED)
        RETURNING files`);
      await enqueueOutbox(tx, {
        topic: OUTBOX_TOPICS.blobDelete,
        payload: { keys: rows.flatMap((r) => r.files.map((f) => f.key)) },
      });
      if (rows.length)
        this.logger.info({ sessions: rows.length }, "swept abandoned upload sessions");
      return { sessions: rows.length };
    });
  }
}
