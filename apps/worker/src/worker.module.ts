import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { createDatabase, type DatabaseHandle } from "@spatial/db";
import { blobStoreFromSettings } from "@spatial/storage";
import { LoggerModule } from "nestjs-pino";
import { BlobGcProcessor } from "./blob-gc.processor";
import { MaintenanceProcessor } from "./maintenance.processor";
import { MediaProcessor } from "./media.processor";
import { OutboxRelay } from "./outbox-relay.service";
import { Queues } from "./queues";
import { DATABASE_HANDLE, SCANS_BLOB_STORE, WORKER_CONFIG } from "./tokens";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}
  async onApplicationShutdown() {
    await this.handle.close();
  }
}

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig): DynamicModule {
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
        DatabaseLifecycle,
        Queues,
        OutboxRelay,
        BlobGcProcessor,
        MediaProcessor,
        MaintenanceProcessor,
      ],
    };
  }
}
