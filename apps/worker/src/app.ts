import "reflect-metadata";
import { type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { WorkerConfig } from "@spatial/config";
import { Logger } from "nestjs-pino";
import { WorkerModule } from "./worker.module";

/** The worker as a Nest application context: no HTTP server, just providers and their lifecycles. */
export async function createWorker(config: WorkerConfig): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  await app.init();
  return app;
}
