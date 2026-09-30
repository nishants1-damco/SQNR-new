// Runs claimed analyses (plan §9.1, §9.4): one processor per provider queue,
// so cloud and local runs have their own concurrency and a production worker
// never consumes `analysis-local` (D12).
//
// Retries: transient failures (network, 5xx, 429, no LLM capacity) are
// thrown back to BullMQ, which retries with backoff and the run resumes from
// its checkpoints. Anything else, or the last attempt, fails the run: the
// scan becomes `failed` with the error so the space page offers a retry.
import { Inject, Injectable } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { type AnalysisEvent, analysisEventsChannel } from "@spatial/contracts";
import { type AnalysisJob, OUTBOX_TOPICS } from "@spatial/db";
import {
  type AnalysisOutcome,
  AnalysisRunError,
  type AnalysisStore,
  type CatalogSource,
  errorCode,
  isRetryable,
  type ProviderFactory,
  runAnalysis,
} from "@spatial/pipeline";
import type { BlobStore } from "@spatial/storage";
import { type Job, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE, type QueueName } from "./queues";
import {
  ANALYSIS_STORE,
  CATALOG_SOURCE,
  PROVIDER_FACTORY,
  SCANS_BLOB_STORE,
  WORKER_CONFIG,
  WORKER_REDIS,
} from "./tokens";

/** What a processor needs besides its queue; shared by both analysis queues. */
@Injectable()
export class AnalysisRunner {
  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(ANALYSIS_STORE) private readonly store: AnalysisStore,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(PROVIDER_FACTORY) private readonly providers: ProviderFactory,
    @Inject(CATALOG_SOURCE) private readonly catalog: CatalogSource,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
    @InjectPinoLogger("AnalysisRunner") private readonly logger: PinoLogger,
  ) {}

  async run(job: Job<AnalysisJob>): Promise<AnalysisOutcome> {
    const data = job.data;
    const run = { analysisId: data.analysisId, scanId: data.scanId, userId: data.userId };
    const attempts = job.opts.attempts ?? 1;
    const lastAttempt = job.attemptsMade + 1 >= attempts;
    try {
      const provider = this.providers.create(data.provider, data.model);
      return await runAnalysis(
        {
          store: this.store,
          blobs: this.blobs,
          provider,
          catalog: this.catalog,
          logger: this.logger,
          reviewBudgetMs: this.config.analysis.reviewBudgetMs,
          onProgress: (event) => this.publish(event),
        },
        run,
      );
    } catch (err) {
      const cause = err instanceof AnalysisRunError ? err.cause : err;
      const usage = err instanceof AnalysisRunError ? err.usage : null;
      const message = cause instanceof Error ? cause.message : "Analysis failed";
      const retry = isRetryable(cause) && !lastAttempt;
      this.logger.warn(
        { err: cause, ...run, attempt: job.attemptsMade + 1, attempts, retry },
        "analysis attempt failed",
      );
      if (retry) {
        await this.store.setStage(run, "retrying", 0).catch(() => undefined);
        await this.publish({ ...run, stage: "retrying", pct: 0, message: "Retrying shortly" });
        throw cause instanceof Error ? cause : new Error(message);
      }
      await this.store.failRun(run, { code: errorCode(cause), message, usage });
      await this.publish({ ...run, stage: "failed", pct: 100, message });
      // Tell BullMQ not to retry: the run is closed.
      throw new UnrecoverableError(message);
    }
  }

  private async publish(event: AnalysisEvent & { userId?: string }) {
    const { userId: _userId, ...message } = event;
    const channel = analysisEventsChannel(this.config.queue.prefix, event.scanId);
    await this.redis.publish(channel, JSON.stringify(message)).catch(() => undefined);
  }
}

abstract class AnalysisProcessor extends QueueProcessor {
  protected constructor(
    queue: QueueName,
    private readonly topic: string,
    config: WorkerConfig,
    concurrency: number,
    private readonly runner: AnalysisRunner,
    logger: PinoLogger,
  ) {
    super(queue, config, concurrency, logger);
  }

  protected handle(job: Job): Promise<AnalysisOutcome> {
    if (job.name !== this.topic) throw new Error(`Unknown analysis job ${job.name}`);
    return this.runner.run(job as Job<AnalysisJob>);
  }
}

@Injectable()
export class AnalysisCloudProcessor extends AnalysisProcessor {
  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    runner: AnalysisRunner,
    @InjectPinoLogger(AnalysisCloudProcessor.name) logger: PinoLogger,
  ) {
    super(
      QUEUE.analysisCloud,
      OUTBOX_TOPICS.analysisCloud,
      config,
      config.concurrency.analysisCloud,
      runner,
      logger,
    );
  }
}

@Injectable()
export class AnalysisLocalProcessor extends AnalysisProcessor {
  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    runner: AnalysisRunner,
    @InjectPinoLogger(AnalysisLocalProcessor.name) logger: PinoLogger,
  ) {
    super(
      QUEUE.analysisLocal,
      OUTBOX_TOPICS.analysisLocal,
      config,
      // Never consumed where local models are disabled (production, D12).
      config.llm.localEnabled ? config.concurrency.analysisLocal : 0,
      runner,
      logger,
    );
  }
}
