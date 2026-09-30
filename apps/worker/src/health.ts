// Liveness and readiness for the container platform (plan §15). Readiness
// checks Postgres and the queue Redis, and turns unhealthy while draining.
import { createServer, type Server } from "node:http";
import type { INestApplicationContext } from "@nestjs/common";
import type { DatabaseHandle } from "@spatial/db";
import { Redis } from "ioredis";
import { DATABASE_HANDLE } from "./tokens";

export function startHealthServer(
  app: INestApplicationContext,
  options: { port: number; redisUrl: string; isDraining: () => boolean },
): Server {
  const database = app.get<DatabaseHandle>(DATABASE_HANDLE);
  const redis = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const server = createServer(async (req, res) => {
    if (req.url === "/health/live") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (req.url === "/health/ready") {
      const ok = await Promise.all([
        database.pool.query("SELECT 1").then(
          () => true,
          () => false,
        ),
        (redis.status === "ready" ? Promise.resolve() : redis.connect())
          .then(() => redis.ping())
          .then(
            () => true,
            () => false,
          ),
      ]).then(([db, queue]) => db && queue && !options.isDraining());
      res
        .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ status: ok ? "ok" : "unavailable" }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("close", () => redis.disconnect());
  server.listen(options.port);
  return server;
}
