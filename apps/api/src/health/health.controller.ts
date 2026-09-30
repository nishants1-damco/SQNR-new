// Liveness and readiness (plan §7.2). Readiness checks the dependencies a
// request needs, so the load balancer only routes to replicas that can serve;
// it also turns unhealthy while the process drains after SIGTERM.
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Res,
  type BeforeApplicationShutdown,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { DatabaseHandle } from "@spatial/db";
import type { FastifyReply } from "fastify";
import { Redis } from "ioredis";
import { Public } from "../auth/public.decorator";
import { DATABASE_HANDLE } from "../database/database.module";
import { REDIS } from "../redis/redis.module";

type CheckResult = { ok: boolean; ms: number; error?: string };

async function timed(check: () => Promise<unknown>): Promise<CheckResult> {
  const started = Date.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2000)),
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: (err as Error).message };
  }
}

@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  draining = false;
  beforeApplicationShutdown() {
    this.draining = true;
  }
}

@ApiExcludeController()
@Public()
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly shutdown: ShutdownState,
  ) {}

  @Get("live")
  @HttpCode(200)
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [database, redis] = await Promise.all([
      timed(() => this.database.pool.query("SELECT 1")),
      timed(() => this.redis.ping()),
    ]);
    const ok = database.ok && redis.ok && !this.shutdown.draining;
    void reply.status(ok ? 200 : 503);
    return {
      status: ok ? "ok" : "unavailable",
      ...(this.shutdown.draining ? { draining: true } : {}),
      checks: { database, redis },
    };
  }
}
