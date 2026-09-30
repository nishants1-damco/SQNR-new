// BullMQ queues (migration plan §9.1). Queue names are stable identifiers;
// QUEUE_PREFIX namespaces them per environment (and per test run).
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { OUTBOX_TOPICS, type OutboxTopic } from "@spatial/db";
import { type JobsOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import { WORKER_CONFIG } from "./tokens";

export const QUEUE = {
  blobGc: "blob-gc",
  media: "media",
  maintenance: "maintenance",
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Which queue each outbox topic is relayed to. */
export const TOPIC_QUEUE: Record<OutboxTopic, QueueName> = {
  [OUTBOX_TOPICS.blobDelete]: QUEUE.blobGc,
  [OUTBOX_TOPICS.blobDeletePrefix]: QUEUE.blobGc,
  [OUTBOX_TOPICS.mediaProcess]: QUEUE.media,
};

/** Retries with backoff; finished jobs are pruned so Redis doesn't grow without bound (§9.1). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/** BullMQ needs `maxRetriesPerRequest: null` so blocking commands wait instead of failing. */
export const redisConnection = (url: string) => new Redis(url, { maxRetriesPerRequest: null });

@Injectable()
export class Queues implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {
    this.connection = redisConnection(config.queue.redisUrl);
  }

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        prefix: this.config.queue.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onApplicationShutdown() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
