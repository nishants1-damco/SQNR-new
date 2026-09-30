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
  /** Set when running behind Front Door / a load balancer, so client IPs are real. */
  TRUST_PROXY: booleanString.default(false),

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
  trustProxy: boolean;
  database: { url: string; replicaUrl: string };
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
  analysis: LlmModelsConfig & { maxStreams: number };
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
    database: { url: databaseUrl, replicaUrl: e.DATABASE_REPLICA_URL ?? databaseUrl },
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
    analysis: { ...llmModels(e, production), maxStreams: e.SSE_MAX_STREAMS },
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
