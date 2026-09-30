import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import { Redis } from "ioredis";
import { API_CONFIG } from "../config/config.module";

/** The cache Redis (rate limits, caches). The queue Redis arrives with the worker. */
export const REDIS = Symbol("REDIS");

@Injectable()
class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit() {
    await this.redis.connect();
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        new Redis(config.redis.cacheUrl, {
          keyPrefix: config.redis.keyPrefix,
          lazyConnect: true,
          // Fail fast instead of queueing while disconnected: callers decide
          // what an outage means (auth rate limits fail closed).
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
