import { telemetry } from "./telemetry";
import "reflect-metadata";
import { loadApiConfig } from "@spatial/config";
import { createApp } from "./app";

async function main() {
  const config = loadApiConfig();
  const app = await createApp(config);
  // SIGTERM: readiness turns unhealthy, in-flight requests finish, pools close.
  app.enableShutdownHooks();
  // Flush the last spans and metrics as the process stops.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void telemetry.shutdown());
  }
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
