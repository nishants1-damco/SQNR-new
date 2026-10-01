// A BullMQ worker tied to the Nest lifecycle: starts when the app boots and,
// on shutdown, stops taking jobs and waits for the ones in progress (§9.5).
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { OUTBOX_TRACE_KEY } from "@spatial/db";
import { inSpan } from "@spatial/observability";
import { type Job, Worker } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { type QueueName, redisConnection } from "./queues";

export abstract class QueueProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker | null = null;

  protected constructor(
    private readonly queueName: QueueName,
    private readonly workerConfig: WorkerConfig,
    private readonly concurrency: number,
    protected readonly logger: PinoLogger,
  ) {}

  protected abstract handle(job: Job): Promise<unknown>;

  onApplicationBootstrap() {
    // A queue this deployment doesn't serve (e.g. analysis-local in production).
    if (this.concurrency < 1) return;
    this.worker = new Worker(
      this.queueName,
      // Each job is a span that continues the trace of the request that queued it.
      (job) =>
        inSpan(`job ${this.queueName}`, () => this.handle(job), {
          carrier: (job.data as Record<string, unknown> | undefined)?.[OUTBOX_TRACE_KEY] as
            Record<string, string> | undefined,
          attributes: {
            "messaging.system": "bullmq",
            "messaging.destination.name": this.queueName,
            "messaging.message.id": job.id ?? "",
            "spatial.job.attempt": job.attemptsMade + 1,
          },
        }),
      {
        connection: redisConnection(this.workerConfig.queue.redisUrl),
        prefix: this.workerConfig.queue.prefix,
        concurrency: this.concurrency,
      },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(
        { err, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade },
        "job failed",
      ),
    );
    this.worker.on("error", (err) => this.logger.error({ err }, "worker error"));
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }
}
