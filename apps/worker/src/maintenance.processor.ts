// Scheduled housekeeping (plan §9.1). A BullMQ job scheduler fires each task
// once per interval across all worker replicas, not once per replica.
//   * upload-sessions.sweep: upload sessions nobody completed are deleted, and
//     whatever was uploaded under their keys is queued for deletion.
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import {
  type DatabaseHandle,
  enqueueOutbox,
  OUTBOX_TOPICS,
  type UploadSessionFile,
} from "@spatial/db";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE, Queues } from "./queues";
import { DATABASE_HANDLE, WORKER_CONFIG } from "./tokens";

export const MAINTENANCE_TASKS = { sweepUploadSessions: "upload-sessions.sweep" } as const;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
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
    await this.queues
      .get(QUEUE.maintenance)
      .upsertJobScheduler(
        MAINTENANCE_TASKS.sweepUploadSessions,
        { every: SWEEP_EVERY_MS },
        { name: MAINTENANCE_TASKS.sweepUploadSessions },
      );
  }

  protected handle(job: Job) {
    if (job.name === MAINTENANCE_TASKS.sweepUploadSessions) return this.sweepUploadSessions();
    throw new Error(`Unknown maintenance job ${job.name}`);
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
