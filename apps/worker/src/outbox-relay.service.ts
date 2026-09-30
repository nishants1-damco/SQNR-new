// Moves committed outbox rows onto the job queues (plan §7.4). Rows are
// claimed with FOR UPDATE SKIP LOCKED, so several worker replicas can drain
// the outbox together without handing out the same row twice; the job id is
// derived from the row id, so a crash between enqueue and marking the row
// dispatched can't create a duplicate job.
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import type { DatabaseHandle, OutboxTopic } from "@spatial/db";
import { sql } from "drizzle-orm";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Queues, TOPIC_QUEUE } from "./queues";
import { DATABASE_HANDLE, WORKER_CONFIG } from "./tokens";

const BATCH = 100;

interface OutboxRow {
  [column: string]: unknown;
  id: number;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly queues: Queues,
    @InjectPinoLogger(OutboxRelay.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap() {
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Relays one batch. Returns how many rows were dispatched. */
  async drainOnce(): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const { rows } = await tx.execute<OutboxRow>(sql`
        SELECT id, topic, payload FROM outbox
        WHERE dispatched_at IS NULL
        ORDER BY id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`);
      let dispatched = 0;
      for (const row of rows) {
        try {
          const queue = TOPIC_QUEUE[row.topic];
          if (!queue) throw new Error(`No queue for topic ${row.topic}`);
          await this.queues.get(queue).add(row.topic, row.payload, { jobId: `outbox-${row.id}` });
          await tx.execute(sql`UPDATE outbox SET dispatched_at = now() WHERE id = ${row.id}`);
          dispatched++;
        } catch (err) {
          this.logger.error({ err, outboxId: row.id, topic: row.topic }, "outbox relay failed");
          await tx.execute(sql`
            UPDATE outbox SET attempts = attempts + 1, last_error = ${String(err).slice(0, 1000)}
            WHERE id = ${row.id}`);
        }
      }
      return dispatched;
    });
  }

  private async run() {
    while (this.running) {
      let dispatched = 0;
      try {
        dispatched = await this.drainOnce();
      } catch (err) {
        this.logger.error({ err }, "outbox relay cycle failed");
      }
      // A full batch means there is probably more waiting: go again at once.
      if (dispatched < BATCH && this.running) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, this.config.outboxPollMs);
        });
      }
    }
  }
}
