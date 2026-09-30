import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import { createDatabase, type Database, type DatabaseHandle } from "@spatial/db";
import { API_CONFIG } from "../config/config.module";

/** The pool + Drizzle handle (for health checks and shutdown). */
export const DATABASE_HANDLE = Symbol("DATABASE_HANDLE");
/** The Drizzle database, for repositories. */
export const DB = Symbol("DB");

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  async onApplicationShutdown() {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createDatabase({ url: config.database.url, applicationName: "spatial-api" }),
    },
    {
      provide: DB,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle): Database => handle.db,
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE_HANDLE, DB],
})
export class DatabaseModule {}
