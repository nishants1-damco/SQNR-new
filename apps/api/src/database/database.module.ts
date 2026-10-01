import {
  type CallHandler,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type NestInterceptor,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { ApiConfig } from "@spatial/config";
import { createDatabase, type Database, type DatabaseHandle } from "@spatial/db";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { tap } from "rxjs";
import { API_CONFIG } from "../config/config.module";
import { REDIS } from "../redis/redis.module";

/** The pool + Drizzle handle (for health checks and shutdown). */
export const DATABASE_HANDLE = Symbol("DATABASE_HANDLE");
/** The Drizzle database on the primary, for repositories. */
export const DB = Symbol("DB");
/** The read replica's pool, or the primary's when no replica is configured. */
export const REPLICA_HANDLE = Symbol("REPLICA_HANDLE");

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle,
    @Inject(REPLICA_HANDLE) private readonly replica: DatabaseHandle,
  ) {}

  async onApplicationShutdown() {
    await this.handle.close();
    if (this.replica !== this.handle) await this.replica.close();
  }
}

const recentWriteKey = (userId: string) => `rw:${userId}`;

/**
 * Picks the database for a user's reads (plan §8.4): the read replica, except
 * for a few seconds after that user wrote something, so nobody reads their
 * own change from a replica that hasn't caught up yet (read-your-writes).
 * Anything uncertain (Redis down) reads from the primary.
 */
@Injectable()
export class ReadRouter {
  private readonly logger = new Logger("ReadRouter");
  readonly hasReplica: boolean;
  private readonly replica: Database;

  constructor(
    @Inject(DB) private readonly primary: Database,
    @Inject(REPLICA_HANDLE) replica: DatabaseHandle,
    @Inject(DATABASE_HANDLE) handle: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    this.hasReplica = replica !== handle;
    this.replica = replica.db;
  }

  async forUser(userId: string): Promise<Database> {
    if (!this.hasReplica) return this.primary;
    try {
      return (await this.redis.exists(recentWriteKey(userId))) ? this.primary : this.replica;
    } catch (err) {
      this.logger.warn({ err }, "can't tell whether the user wrote recently; reading the primary");
      return this.primary;
    }
  }

  /** Called after a user's successful write. */
  async markWrite(userId: string): Promise<void> {
    const seconds = this.config.database.replicaStickySeconds;
    if (!this.hasReplica || seconds <= 0) return;
    await this.redis.set(recentWriteKey(userId), "1", "EX", seconds).catch(() => undefined);
  }
}

/** Marks the caller as a recent writer after every successful non-GET request. */
@Injectable()
class RecentWriteInterceptor implements NestInterceptor {
  constructor(private readonly router: ReadRouter) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const userId = request.user?.id;
    const reading = request.method === "GET" || request.method === "HEAD";
    if (!userId || reading || !this.router.hasReplica) return next.handle();
    return next.handle().pipe(tap({ next: () => void this.router.markWrite(userId) }));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createDatabase({
          url: config.database.url,
          applicationName: "spatial-api",
          max: config.database.poolMax,
          connectionTimeoutMs: config.database.poolWaitMs,
        }),
    },
    {
      provide: REPLICA_HANDLE,
      inject: [API_CONFIG, DATABASE_HANDLE],
      useFactory: (config: ApiConfig, primary: DatabaseHandle) =>
        config.database.replicaUrl === config.database.url
          ? primary
          : createDatabase({
              url: config.database.replicaUrl,
              applicationName: "spatial-api-read",
              max: config.database.poolMax,
              connectionTimeoutMs: config.database.poolWaitMs,
            }),
    },
    {
      provide: DB,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle): Database => handle.db,
    },
    DatabaseLifecycle,
    ReadRouter,
    { provide: APP_INTERCEPTOR, useClass: RecentWriteInterceptor },
  ],
  exports: [DATABASE_HANDLE, DB, ReadRouter],
})
export class DatabaseModule {}
