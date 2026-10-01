import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { createDatabase, type DatabaseHandle } from "@spatial/db";
import {
  AnalysisStore,
  CatalogSource,
  createEmbedder,
  type LlmGate,
  ProviderFactory,
  RedisLlmGate,
} from "@spatial/pipeline";
import { blobStoreFromSettings } from "@spatial/storage";
import { Redis } from "ioredis";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import {
  AnalysisCloudProcessor,
  AnalysisLocalProcessor,
  AnalysisRunner,
} from "./analysis.processor";
import { BlobGcProcessor } from "./blob-gc.processor";
import { MaintenanceProcessor } from "./maintenance.processor";
import { MediaProcessor } from "./media.processor";
import { OutboxRelay } from "./outbox-relay.service";
import { PrivacyPurgeProcessor } from "./privacy-purge.processor";
import { Queues } from "./queues";
import {
  ANALYSIS_STORE,
  CATALOG_SOURCE,
  DATABASE_HANDLE,
  PROVIDER_FACTORY,
  SCANS_BLOB_STORE,
  WORKER_CONFIG,
  WORKER_REDIS,
} from "./tokens";

/** Replaceable parts, for tests (e.g. a scripted model instead of Claude). */
export interface WorkerOverrides {
  providers?: Pick<ProviderFactory, "create">;
}

@Injectable()
class ConnectionsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown() {
    await this.handle.close();
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig, overrides: WorkerOverrides = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.logLevel,
            ...(config.env === "development"
              ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
              : {}),
          },
        }),
      ],
      providers: [
        { provide: WORKER_CONFIG, useValue: config },
        {
          provide: DATABASE_HANDLE,
          useFactory: () =>
            createDatabase({ url: config.database.url, applicationName: "spatial-worker" }),
        },
        {
          provide: SCANS_BLOB_STORE,
          useFactory: () => blobStoreFromSettings(config.blob, config.blob.containers.scans),
        },
        { provide: WORKER_REDIS, useFactory: () => new Redis(config.queue.redisUrl) },
        {
          provide: ANALYSIS_STORE,
          inject: [DATABASE_HANDLE],
          useFactory: (handle: DatabaseHandle) => new AnalysisStore(handle.db),
        },
        {
          provide: CATALOG_SOURCE,
          inject: [DATABASE_HANDLE, PinoLogger],
          useFactory: (handle: DatabaseHandle, logger: PinoLogger) =>
            new CatalogSource({
              db: handle.db,
              embedder: createEmbedder(config.embeddings),
              logger,
              imageOrigins: config.catalogImageOrigins,
              images: blobStoreFromSettings(config.blob, config.blob.containers.catalogImages),
            }),
        },
        {
          provide: PROVIDER_FACTORY,
          inject: [WORKER_REDIS, PinoLogger],
          useFactory: (redis: Redis, logger: PinoLogger) => {
            if (overrides.providers) return overrides.providers;
            const gate: LlmGate = new RedisLlmGate(redis, {
              prefix: config.queue.prefix,
              limits: config.llm.limits,
            });
            return new ProviderFactory(
              {
                anthropic: {
                  apiKey: config.llm.anthropic.apiKey,
                  model: config.llm.models.claude,
                  fallbackModel: config.llm.anthropic.fallbackModel,
                  refusalFallbacks: config.llm.anthropic.refusalFallbacks,
                },
                local: {
                  enabled: config.llm.localEnabled,
                  baseUrl: config.llm.localBaseUrl,
                  model: config.llm.models.ollama,
                },
                stub: config.llmStub,
              },
              gate,
              logger,
            );
          },
        },
        ConnectionsLifecycle,
        Queues,
        OutboxRelay,
        BlobGcProcessor,
        MediaProcessor,
        MaintenanceProcessor,
        AnalysisRunner,
        AnalysisCloudProcessor,
        AnalysisLocalProcessor,
        PrivacyPurgeProcessor,
      ],
    };
  }
}
