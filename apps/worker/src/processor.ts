// A BullMQ worker tied to the Nest lifecycle: starts when the app boots and,
// on shutdown, stops taking jobs and waits for the ones in progress (§9.5).
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
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
    this.worker = new Worker(this.queueName, (job) => this.handle(job), {
      connection: redisConnection(this.workerConfig.queue.redisUrl),
      prefix: this.workerConfig.queue.prefix,
      concurrency: this.concurrency,
    });
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
