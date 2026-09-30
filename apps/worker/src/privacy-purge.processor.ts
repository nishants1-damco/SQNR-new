// The on-demand privacy sweep (plan §9.1): re-screen every frame of a scan
// for people and delete the matches. Runs on Claude (the production
// provider); shares the LLM gate with analyses.
import { Inject, Injectable } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { OUTBOX_TOPICS, type PrivacyPurgeJob } from "@spatial/db";
import {
  type AnalysisStore,
  failPrivacyPurge,
  isRetryable,
  type ProviderFactory,
  runPrivacyPurge,
} from "@spatial/pipeline";
import type { BlobStore } from "@spatial/storage";
import { type Job, UnrecoverableError } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE } from "./queues";
import { ANALYSIS_STORE, PROVIDER_FACTORY, SCANS_BLOB_STORE, WORKER_CONFIG } from "./tokens";

@Injectable()
export class PrivacyPurgeProcessor extends QueueProcessor {
  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(ANALYSIS_STORE) private readonly store: AnalysisStore,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(PROVIDER_FACTORY) private readonly providers: ProviderFactory,
    @InjectPinoLogger(PrivacyPurgeProcessor.name) logger: PinoLogger,
  ) {
    super(QUEUE.privacyPurge, config, config.concurrency.privacyPurge, logger);
  }

  protected async handle(job: Job) {
    if (job.name !== OUTBOX_TOPICS.privacyPurge) throw new Error(`Unknown job ${job.name}`);
    const data = job.data as PrivacyPurgeJob;
    try {
      const provider = this.providers.create(this.config.llm.defaultProvider);
      return await runPrivacyPurge(
        { store: this.store, blobs: this.blobs, provider, logger: this.logger },
        data,
      );
    } catch (err) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isRetryable(err) && !lastAttempt) throw err;
      const message = err instanceof Error ? err.message : "Privacy sweep failed";
      await failPrivacyPurge(this.store, data, message);
      throw new UnrecoverableError(message);
    }
  }
}
