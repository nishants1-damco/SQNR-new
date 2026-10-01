// Imported first by main.ts: OpenTelemetry has to start before the modules it
// instruments (http, fastify, pg, ioredis, undici, pino) are loaded. Reads
// .env itself for the same reason. Off unless an OTLP endpoint is configured.
import { existsSync } from "node:fs";
import { startTelemetry } from "@spatial/observability";

// Local convenience only; deployed environments set real environment variables.
if (existsSync(".env")) process.loadEnvFile(".env");

export const telemetry = startTelemetry({
  serviceName: "spatial-api",
  ...(process.env["APP_VERSION"] ? { serviceVersion: process.env["APP_VERSION"] } : {}),
  environment: process.env["DEPLOY_ENV"] ?? process.env["NODE_ENV"] ?? "development",
});
