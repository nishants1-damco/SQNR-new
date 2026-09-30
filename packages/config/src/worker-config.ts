// Validated configuration for apps/worker. Same rules as the API: local-stack
// defaults outside production, explicit settings required in production.
import { z } from "zod";
import { ConfigError } from "./api-config";
import { localStack } from "./local-stack";

const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url().optional(),
  /** The queue Redis: noeviction + persistence (plan §9.2). */
  REDIS_QUEUE_URL: z.url().optional(),
  /** Namespaces BullMQ keys, so environments (and test runs) sharing a Redis never collide. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[\w:-]+$/)
    .default("spatial"),
  BLOB_CONNECTION_STRING: z.string().min(1).optional(),
  BLOB_ACCOUNT_URL: z.url().optional(),
  BLOB_CONTAINER_SCANS: z.string().default("scans"),
  /** How often the outbox is drained when it was empty last time. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  BLOB_GC_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Liveness/readiness endpoint for the container platform; 0 disables it. */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3100),
});

export interface WorkerConfig {
  env: "development" | "test" | "production";
  logLevel: string;
  database: { url: string };
  queue: { redisUrl: string; prefix: string };
  blob: {
    connectionString: string | null;
    accountUrl: string | null;
    publicEndpoint: null;
    containers: { scans: string };
  };
  outboxPollMs: number;
  concurrency: { media: number; blobGc: number };
  healthPort: number;
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const parsed = WorkerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  if (production) {
    const problems: string[] = [];
    if (!e.DATABASE_URL) problems.push("DATABASE_URL: required in production");
    if (!e.REDIS_QUEUE_URL) problems.push("REDIS_QUEUE_URL: required in production");
    if (!e.BLOB_ACCOUNT_URL && !e.BLOB_CONNECTION_STRING) {
      problems.push("BLOB_ACCOUNT_URL: required in production (or BLOB_CONNECTION_STRING)");
    }
    if (problems.length) throw new ConfigError(problems);
  }
  const local = production ? null : localStack({ env });
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL ?? local?.appDatabaseUrl ?? "" },
    queue: { redisUrl: e.REDIS_QUEUE_URL ?? local?.redisUrl ?? "", prefix: e.QUEUE_PREFIX },
    blob: {
      connectionString:
        e.BLOB_CONNECTION_STRING ??
        (e.BLOB_ACCOUNT_URL ? null : (local?.blob.connectionString ?? null)),
      accountUrl: e.BLOB_ACCOUNT_URL ?? null,
      publicEndpoint: null,
      containers: { scans: e.BLOB_CONTAINER_SCANS },
    },
    outboxPollMs: e.OUTBOX_POLL_MS,
    concurrency: { media: e.MEDIA_CONCURRENCY, blobGc: e.BLOB_GC_CONCURRENCY },
    healthPort: e.HEALTH_PORT,
  };
}
