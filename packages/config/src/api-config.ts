// Validated configuration for apps/api (migration plan §14.1). Every variable
// is read here exactly once. In development and test, anything not set falls
// back to the local Docker stack; in production those defaults are refused
// and every connection and secret must be set explicitly.
import { z } from "zod";
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

const ApiEnvSchema = LlmEnvSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /**
   * Proxies in front of the API whose X-Forwarded-For entries are believed: a
   * hop count (Azure: 2, Front Door then the Container Apps ingress), or
   * true/false. `true` trusts every entry, so clients could pick their own IP
   * for rate limits; it is refused in production.
   */
  TRUST_PROXY: z
    .union([z.enum(["true", "false"]), z.coerce.number().int().min(0).max(10)])
    .default("false")
    .transform((v) => (v === "true" ? true : v === "false" ? false : v)),
  /**
   * Front Door profile id. When set, requests without a matching X-Azure-FDID
   * header are refused, so the API can't be reached around Front Door (and
   * its WAF) or have X-Forwarded-For spoofed. Health probes are exempt.
   */
  FRONT_DOOR_ID: z.uuid().optional(),

  DATABASE_URL: z.url().optional(),
  DATABASE_REPLICA_URL: z.url().optional(),
  REDIS_CACHE_URL: z.url().optional(),
  /** Namespaces every key, so environments (and test runs) sharing a Redis never collide. */
  REDIS_KEY_PREFIX: z.string().default("spatial:"),
  /** The worker's queue Redis: analysis progress events are published there (plan §9.6). */
  REDIS_QUEUE_URL: z.url().optional(),
  /** Must match the worker's QUEUE_PREFIX. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[\w:-]+$/)
    .default("spatial"),
  /** Open analysis event streams one API replica serves at most. */
  SSE_MAX_STREAMS: z.coerce.number().int().min(1).max(100_000).default(2000),
  /** Reads go to the primary for this long after a user's write (read-your-writes). */
  REPLICA_STICKY_SECONDS: z.coerce.number().int().min(0).max(300).default(10),
  /** Connections per pool (primary and replica each). PgBouncer multiplexes them. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  /** How long a request waits for a free connection before a 503. */
  DATABASE_POOL_WAIT_MS: z.coerce.number().int().min(100).default(2000),

  /** Where per-user quotas are counted: Redis (default) or the original SQL function. */
  QUOTA_BACKEND: z.enum(["redis", "postgres"]).default("redis"),
  /** Requests per minute per signed-in user, and per IP for anonymous routes; 0 = off. */
  THROTTLE_USER_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  THROTTLE_IP_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  /** Daily AI spend caps in USD (plan §9.7.6); 0 = no cap. */
  AI_DAILY_BUDGET_USD_PER_USER: z.coerce.number().min(0).default(25),
  AI_DAILY_BUDGET_USD_GLOBAL: z.coerce.number().min(0).default(0),
  /** What a queued or running analysis is assumed to cost until it reports its real cost. */
  ANALYSIS_COST_ESTIMATE_USD: z.coerce.number().min(0).default(5.2),
  /** Refuse new analyses with 503 while this many are waiting (plan §9.3); 0 = no limit. */
  ANALYSIS_MAX_QUEUED: z.coerce.number().int().min(0).default(500),

  WEB_ORIGINS: csv.default(["http://localhost:5173"]),
  /** Where emailed links point (the web app). */
  APP_BASE_URL: z.url().default("http://localhost:5173"),

  /** Ed25519 private key, PKCS#8 PEM. Optional outside production (an ephemeral key is generated). */
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_KEY_ID: z.string().min(1).optional(),
  /** Previous public key (SPKI PEM) kept in the JWKS during a key rotation. */
  JWT_PREVIOUS_PUBLIC_KEY: z.string().min(1).optional(),
  JWT_PREVIOUS_KEY_ID: z.string().min(1).optional(),
  JWT_ISSUER: z.string().default("spatial-capture-api"),
  JWT_AUDIENCE: z.string().default("spatial-capture"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: booleanString.optional(),

  /** Account-key connection string (Azurite locally). */
  BLOB_CONNECTION_STRING: z.string().min(1).optional(),
  /** `https://<account>.blob.core.windows.net`; used with managed identity in Azure. */
  BLOB_ACCOUNT_URL: z.url().optional(),
  /** Origin browsers use for SAS URLs, if not the storage endpoint itself. */
  BLOB_PUBLIC_ENDPOINT: z.url().optional(),
  BLOB_CONTAINER_SCANS: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/, "not a valid container name")
    .default("scans"),

  /** Reverse/forward geocoding. `fake` returns fixed results (tests); `disabled` returns none. */
  GEOCODER_PROVIDER: z.enum(["nominatim", "fake", "disabled"]).default("nominatim"),
  GEOCODER_USER_AGENT: z.string().default("SQNR-VectorCapture/1.0 (spatial scan app)"),

  SMTP_URL: z.string().min(1).optional(),
  MAIL_FROM: z.string().default("Spatial Capture <no-reply@spatial.local>"),
});

export interface ApiConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean | number;
  /** Requests must carry this X-Azure-FDID; null to accept any. */
  frontDoorId: string | null;
  database: {
    url: string;
    replicaUrl: string;
    replicaStickySeconds: number;
    poolMax: number;
    poolWaitMs: number;
  };
  redis: { cacheUrl: string; keyPrefix: string };
  web: { origins: string[]; appBaseUrl: string };
  auth: {
    issuer: string;
    audience: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    cookieSecure: boolean;
    /** Null outside production when no key is configured: the API generates one per process. */
    signingKey: { privateKeyPem: string; keyId: string } | null;
    previousKey: { publicKeyPem: string; keyId: string } | null;
  };
  mail: { smtpUrl: string; from: string };
  blob: {
    connectionString: string | null;
    accountUrl: string | null;
    publicEndpoint: string | null;
    containers: { scans: string };
  };
  geocoder: { provider: "nominatim" | "fake" | "disabled"; userAgent: string };
  queue: { redisUrl: string; prefix: string };
  analysis: LlmModelsConfig & { maxStreams: number; maxQueued: number };
  limits: {
    quotaBackend: "redis" | "postgres";
    throttle: { userPerMinute: number; ipPerMinute: number };
    budgets: { perUserDailyUsd: number; globalDailyUsd: number; runEstimateUsd: number };
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid API configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** PEM values often arrive with literal "\n" sequences from env files and secret stores. */
const pem = (value: string) => value.replace(/\\n/g, "\n");

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = ApiEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";

  const problems: string[] = llmConfigProblems(e, production);
  if (production) {
    for (const name of [
      "DATABASE_URL",
      "REDIS_CACHE_URL",
      "REDIS_QUEUE_URL",
      "JWT_PRIVATE_KEY",
      "JWT_KEY_ID",
      "SMTP_URL",
    ] as const) {
      if (!e[name]) problems.push(`${name}: required in production`);
    }
    if (e.COOKIE_SECURE === false) problems.push("COOKIE_SECURE: must not be false in production");
    if (e.TRUST_PROXY === true) {
      problems.push("TRUST_PROXY: use a hop count in production, not true (spoofable client IPs)");
    }
    if (typeof e.TRUST_PROXY === "number" && e.TRUST_PROXY > 0 && !e.FRONT_DOOR_ID) {
      problems.push(
        "FRONT_DOOR_ID: required with a TRUST_PROXY hop count in production (direct clients could forge X-Forwarded-For)",
      );
    }
    if (!e.BLOB_ACCOUNT_URL && !e.BLOB_CONNECTION_STRING) {
      problems.push("BLOB_ACCOUNT_URL: required in production (or BLOB_CONNECTION_STRING)");
    }
    if (e.GEOCODER_PROVIDER === "fake") problems.push("GEOCODER_PROVIDER: fake is for tests only");
  }
  if (e.JWT_PRIVATE_KEY && !e.JWT_KEY_ID)
    problems.push("JWT_KEY_ID: required with JWT_PRIVATE_KEY");
  if (Boolean(e.JWT_PREVIOUS_PUBLIC_KEY) !== Boolean(e.JWT_PREVIOUS_KEY_ID)) {
    problems.push("JWT_PREVIOUS_PUBLIC_KEY and JWT_PREVIOUS_KEY_ID must be set together");
  }
  if (problems.length) throw new ConfigError(problems);

  // Only reached with explicit values in production (checked above).
  const local = production ? null : localStack({ env });
  const databaseUrl = e.DATABASE_URL ?? local?.appDatabaseUrl ?? "";

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    frontDoorId: e.FRONT_DOOR_ID ?? null,
    database: {
      url: databaseUrl,
      replicaUrl: e.DATABASE_REPLICA_URL ?? databaseUrl,
      replicaStickySeconds: e.REPLICA_STICKY_SECONDS,
      poolMax: e.DATABASE_POOL_MAX,
      poolWaitMs: e.DATABASE_POOL_WAIT_MS,
    },
    redis: { cacheUrl: e.REDIS_CACHE_URL ?? local?.redisUrl ?? "", keyPrefix: e.REDIS_KEY_PREFIX },
    web: { origins: e.WEB_ORIGINS, appBaseUrl: e.APP_BASE_URL.replace(/\/$/, "") },
    auth: {
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      cookieSecure: e.COOKIE_SECURE ?? production,
      signingKey:
        e.JWT_PRIVATE_KEY && e.JWT_KEY_ID
          ? { privateKeyPem: pem(e.JWT_PRIVATE_KEY), keyId: e.JWT_KEY_ID }
          : null,
      previousKey:
        e.JWT_PREVIOUS_PUBLIC_KEY && e.JWT_PREVIOUS_KEY_ID
          ? { publicKeyPem: pem(e.JWT_PREVIOUS_PUBLIC_KEY), keyId: e.JWT_PREVIOUS_KEY_ID }
          : null,
    },
    mail: { smtpUrl: e.SMTP_URL ?? local?.smtpUrl ?? "", from: e.MAIL_FROM },
    blob: {
      // With an account URL, Azure credentials (managed identity) sign instead of a key.
      connectionString:
        e.BLOB_CONNECTION_STRING ??
        (e.BLOB_ACCOUNT_URL ? null : (local?.blob.connectionString ?? null)),
      accountUrl: e.BLOB_ACCOUNT_URL ?? null,
      publicEndpoint: e.BLOB_PUBLIC_ENDPOINT ?? null,
      containers: { scans: e.BLOB_CONTAINER_SCANS },
    },
    geocoder: { provider: e.GEOCODER_PROVIDER, userAgent: e.GEOCODER_USER_AGENT },
    queue: { redisUrl: e.REDIS_QUEUE_URL ?? local?.redisUrl ?? "", prefix: e.QUEUE_PREFIX },
    analysis: {
      ...llmModels(e, production),
      maxStreams: e.SSE_MAX_STREAMS,
      maxQueued: e.ANALYSIS_MAX_QUEUED,
    },
    limits: {
      quotaBackend: e.QUOTA_BACKEND,
      throttle: {
        userPerMinute: e.THROTTLE_USER_PER_MINUTE,
        ipPerMinute: e.THROTTLE_IP_PER_MINUTE,
      },
      budgets: {
        perUserDailyUsd: e.AI_DAILY_BUDGET_USD_PER_USER,
        globalDailyUsd: e.AI_DAILY_BUDGET_USD_GLOBAL,
        runEstimateUsd: e.ANALYSIS_COST_ESTIMATE_USD,
      },
    },
  };
}

/** Connection for running migrations: the schema owner, directly (not via PgBouncer). */
export function loadMigratorDatabaseUrl(env: Record<string, string | undefined> = process.env) {
  if (env["DATABASE_MIGRATOR_URL"]) return env["DATABASE_MIGRATOR_URL"];
  if (env["NODE_ENV"] === "production") {
    throw new ConfigError(["DATABASE_MIGRATOR_URL: required in production"]);
  }
  return localStack({ env }).migratorDatabaseUrl;
}
