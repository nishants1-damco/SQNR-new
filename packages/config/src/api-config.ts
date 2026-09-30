// Validated configuration for apps/api (migration plan §14.1). Every variable
// is read here exactly once. In development and test, anything not set falls
// back to the local Docker stack; in production those defaults are refused
// and every connection and secret must be set explicitly.
import { z } from "zod";
import { localStack } from "./local-stack";

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);

const ApiEnvSchema = z.object({
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

  const problems: string[] = [];
  if (production) {
    for (const name of [
      "DATABASE_URL",
      "REDIS_CACHE_URL",
      "JWT_PRIVATE_KEY",
      "JWT_KEY_ID",
      "SMTP_URL",
    ] as const) {
      if (!e[name]) problems.push(`${name}: required in production`);
    }
    if (e.COOKIE_SECURE === false) problems.push("COOKIE_SECURE: must not be false in production");
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
