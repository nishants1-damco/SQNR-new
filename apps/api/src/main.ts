import "reflect-metadata";
import { existsSync } from "node:fs";
import { loadApiConfig } from "@spatial/config";
import { createApp } from "./app";

async function main() {
  // Local convenience only; deployed environments set real environment variables.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadApiConfig();
  const app = await createApp(config);
  // SIGTERM: readiness turns unhealthy, in-flight requests finish, pools close.
  app.enableShutdownHooks();
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
