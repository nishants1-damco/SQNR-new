import { existsSync } from "node:fs";
import { loadWorkerConfig } from "@spatial/config";
import { createWorker } from "./app";
import { startHealthServer } from "./health";

async function main() {
  // Local convenience only; deployed environments set real environment variables.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadWorkerConfig();
  const app = await createWorker(config);

  let draining = false;
  const health =
    config.healthPort > 0
      ? startHealthServer(app, {
          port: config.healthPort,
          redisUrl: config.queue.redisUrl,
          isDraining: () => draining,
        })
      : null;

  // SIGTERM (deploys, scale-in): report not-ready, stop taking jobs, let
  // running ones finish, close connections.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      draining = true;
      void app
        .close()
        .then(() => health?.close())
        .finally(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
