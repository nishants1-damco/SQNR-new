// Validated configuration for apps/worker. Same rules as the API: local-stack
// defaults outside production, explicit settings required in production.
import { z } from "zod";
import { ConfigError } from "./api-config";
import {
  booleanString,
  llmConfigProblems,
  LlmEnvSchema,
  llmModels,
  type LlmModelsConfig,
} from "./llm-config";
import { localStack } from "./local-stack";

const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);

const WorkerEnvSchema = LlmEnvSchema.extend({
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

  /** Analyses one worker runs at once, per queue (plan §9.1). */
  ANALYSIS_CLOUD_CONCURRENCY: z.coerce.number().int().min(0).max(16).default(2),
  ANALYSIS_LOCAL_CONCURRENCY: z.coerce.number().int().min(0).max(4).default(1),
  PRIVACY_PURGE_CONCURRENCY: z.coerce.number().int().min(0).max(16).default(2),
  /** Job attempts for an analysis; retries resume from checkpoints. */
  ANALYSIS_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** Skip the review pass after this long, unless the draft has structural problems. */
  ANALYSIS_REVIEW_BUDGET_MS: z.coerce.number().int().min(0).default(100_000),

  /** Model calls in flight across all workers (plan §9.7.6). */
  LLM_PERMITS_CLAUDE: z.coerce.number().int().min(1).max(1000).default(16),
  LLM_PERMITS_LOCAL: z.coerce.number().int().min(1).max(16).default(1),
  /** Set to 85% of the granted Anthropic limits; 0 = not limited here. */
  LLM_RPM_LIMIT: z.coerce.number().int().min(0).default(0),
  LLM_ITPM_LIMIT: z.coerce.number().int().min(0).default(0),
  LLM_OTPM_LIMIT: z.coerce.number().int().min(0).default(0),

  /** Product-catalog embeddings (independent of the generation provider). */
  EMBEDDING_PROVIDER: z.enum(["gemini", "ollama", "none"]).default("none"),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** Origins catalog reference photos may be downloaded from (https only). */
  CATALOG_IMAGE_ORIGINS: csv.default([]),

  /** development | staging | production: where this runs, beyond NODE_ENV. */
  DEPLOY_ENV: z.enum(["development", "staging", "production"]).optional(),
  /** Load tests (plan §18.1): a stand-in model with latency and 429s. Refused in production. */
  LLM_STUB: booleanString.default(false),
  LLM_STUB_LATENCY_MS: z.coerce.number().int().min(0).default(60_000),
  LLM_STUB_429_RATE: z.coerce.number().min(0).max(1).default(0.02),
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
  concurrency: {
    media: number;
    blobGc: number;
    analysisCloud: number;
    analysisLocal: number;
    privacyPurge: number;
  };
  healthPort: number;
  analysis: { attempts: number; reviewBudgetMs: number };
  llm: LlmModelsConfig & {
    anthropic: { apiKey: string | null; fallbackModel: string; refusalFallbacks: boolean };
    localBaseUrl: string;
    limits: {
      claude: { permits: number; rpm: number; itpm: number; otpm: number };
      ollama: { permits: number; rpm: number; itpm: number; otpm: number };
    };
  };
  embeddings: {
    provider: "gemini" | "ollama" | "none";
    model: string;
    apiKey: string | null;
    baseUrl: string;
  };
  catalogImageOrigins: string[];
  /** Load-test model stub, or null. */
  llmStub: { latencyMs: number; rateLimitRate: number } | null;
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
  const llmProblems = llmConfigProblems(e, production);
  if (
    e.LLM_STUB &&
    (e.DEPLOY_ENV ?? (production ? "production" : "development")) === "production"
  ) {
    llmProblems.push("LLM_STUB: the load-test model stub is refused in production");
  }
  if (llmProblems.length) throw new ConfigError(llmProblems);
  if (production) {
    const problems: string[] = [];
    if (!e.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY: required in production");
    if (!e.DATABASE_URL) problems.push("DATABASE_URL: required in production");
    if (!e.REDIS_QUEUE_URL) problems.push("REDIS_QUEUE_URL: required in production");
    if (!e.BLOB_ACCOUNT_URL && !e.BLOB_CONNECTION_STRING) {
      problems.push("BLOB_ACCOUNT_URL: required in production (or BLOB_CONNECTION_STRING)");
    }
    if (problems.length) throw new ConfigError(problems);
  }
  const local = production ? null : localStack({ env });
  const localBaseUrl = e.LLM_LOCAL_BASE_URL ?? (local ? `${local.ollamaUrl}/v1` : "");
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
    concurrency: {
      media: e.MEDIA_CONCURRENCY,
      blobGc: e.BLOB_GC_CONCURRENCY,
      analysisCloud: e.ANALYSIS_CLOUD_CONCURRENCY,
      analysisLocal: e.ANALYSIS_LOCAL_CONCURRENCY,
      privacyPurge: e.PRIVACY_PURGE_CONCURRENCY,
    },
    healthPort: e.HEALTH_PORT,
    analysis: { attempts: e.ANALYSIS_ATTEMPTS, reviewBudgetMs: e.ANALYSIS_REVIEW_BUDGET_MS },
    llm: {
      ...llmModels(e, production),
      anthropic: {
        apiKey: e.ANTHROPIC_API_KEY ?? null,
        fallbackModel: e.ANTHROPIC_FALLBACK_MODEL,
        refusalFallbacks: e.ANTHROPIC_REFUSAL_FALLBACKS,
      },
      localBaseUrl: localBaseUrl.replace(/\/$/, ""),
      limits: {
        claude: {
          permits: e.LLM_PERMITS_CLAUDE,
          rpm: e.LLM_RPM_LIMIT,
          itpm: e.LLM_ITPM_LIMIT,
          otpm: e.LLM_OTPM_LIMIT,
        },
        ollama: { permits: e.LLM_PERMITS_LOCAL, rpm: 0, itpm: 0, otpm: 0 },
      },
    },
    embeddings: {
      provider: e.EMBEDDING_PROVIDER,
      model:
        e.EMBEDDING_MODEL ??
        (e.EMBEDDING_PROVIDER === "ollama" ? "nomic-embed-text" : "gemini-embedding-001"),
      apiKey: e.GEMINI_API_KEY ?? null,
      baseUrl: localBaseUrl,
    },
    catalogImageOrigins: e.CATALOG_IMAGE_ORIGINS.map((origin) => new URL(origin).origin),
    llmStub: e.LLM_STUB
      ? { latencyMs: e.LLM_STUB_LATENCY_MS, rateLimitRate: e.LLM_STUB_429_RATE }
      : null,
  };
}
