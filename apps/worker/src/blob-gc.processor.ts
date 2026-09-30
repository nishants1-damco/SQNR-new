// Deletes blobs after the rows that referenced them are gone (plan §9.1).
// Idempotent: deleting a missing blob is a no-op, so retries are safe.
import { Inject, Injectable } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { OUTBOX_TOPICS } from "@spatial/db";
import type { BlobStore } from "@spatial/storage";
import type { Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE } from "./queues";
import { SCANS_BLOB_STORE, WORKER_CONFIG } from "./tokens";

@Injectable()
export class BlobGcProcessor extends QueueProcessor {
  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
    @InjectPinoLogger(BlobGcProcessor.name) logger: PinoLogger,
  ) {
    super(QUEUE.blobGc, config, config.concurrency.blobGc, logger);
  }

  protected async handle(job: Job): Promise<{ deleted: number }> {
    if (job.name === OUTBOX_TOPICS.blobDelete) {
      const { keys } = job.data as { keys: string[] };
      return { deleted: await this.blobs.delete(keys) };
    }
    if (job.name === OUTBOX_TOPICS.blobDeletePrefix) {
      const { prefix } = job.data as { prefix: string };
      return { deleted: await this.blobs.deletePrefix(prefix) };
    }
    throw new Error(`Unknown blob-gc job ${job.name}`);
  }
}
