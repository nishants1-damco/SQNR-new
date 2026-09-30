import { describe, expect, it } from "vitest";
import { ConfigError, loadApiConfig, loadMigratorDatabaseUrl } from "./api-config";

const ports = { POSTGRES_PORT: "5433", PGBOUNCER_PORT: "6432", REDIS_PORT: "6379" };

describe("loadApiConfig", () => {
  it("fills development defaults from the local stack", () => {
    const config = loadApiConfig({ ...ports });
    expect(config.env).toBe("development");
    expect(config.database.url).toBe("postgres://app_rw:app_rw_dev@127.0.0.1:6432/spatial");
    expect(config.database.replicaUrl).toBe(config.database.url);
    expect(config.redis.cacheUrl).toBe("redis://127.0.0.1:6379");
    expect(config.auth.signingKey).toBeNull();
    expect(config.auth.cookieSecure).toBe(false);
  });

  it("refuses local defaults and missing secrets in production", () => {
    const attempt = () => loadApiConfig({ NODE_ENV: "production" });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (err) {
      const names = (err as ConfigError).problems.map((p) => p.split(":")[0]);
      expect(names).toEqual([
        "DATABASE_URL",
        "REDIS_CACHE_URL",
        "REDIS_QUEUE_URL",
        "JWT_PRIVATE_KEY",
        "JWT_KEY_ID",
        "SMTP_URL",
        "BLOB_ACCOUNT_URL",
      ]);
    }
  });

  it("accepts a complete production configuration and defaults cookies to Secure", () => {
    const config = loadApiConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://app:secret@db.internal:6432/spatial",
      REDIS_CACHE_URL: "rediss://cache.internal:6380",
      REDIS_QUEUE_URL: "rediss://queue.internal:6380",
      JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      JWT_KEY_ID: "2026-09",
      SMTP_URL: "smtp://mail.internal:587",
      BLOB_ACCOUNT_URL: "https://spatialprod.blob.core.windows.net",
      WEB_ORIGINS: "https://app.example.com, https://www.example.com",
    });
    expect(config.auth.cookieSecure).toBe(true);
    expect(config.auth.signingKey?.privateKeyPem).toContain("\nabc\n");
    expect(config.web.origins).toEqual(["https://app.example.com", "https://www.example.com"]);
    // Managed identity signs in Azure: no account key is configured or inferred.
    expect(config.blob).toMatchObject({
      accountUrl: "https://spatialprod.blob.core.windows.net",
      connectionString: null,
    });
  });

  it("rejects insecure cookies in production and half-configured key rotation", () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://a@b/c",
        REDIS_CACHE_URL: "redis://r",
        JWT_PRIVATE_KEY: "k",
        JWT_KEY_ID: "1",
        SMTP_URL: "smtp://m",
        BLOB_ACCOUNT_URL: "https://a.blob.core.windows.net",
        COOKIE_SECURE: "false",
      }),
    ).toThrow(/COOKIE_SECURE/);
    expect(() => loadApiConfig({ ...ports, JWT_PREVIOUS_KEY_ID: "old" })).toThrow(
      /JWT_PREVIOUS_PUBLIC_KEY/,
    );
  });
});

describe("loadMigratorDatabaseUrl", () => {
  it("uses the schema owner directly against Postgres, not PgBouncer", () => {
    expect(loadMigratorDatabaseUrl({ ...ports })).toBe(
      "postgres://app_migrator:app_migrator_dev@127.0.0.1:5433/spatial",
    );
    expect(() => loadMigratorDatabaseUrl({ NODE_ENV: "production" })).toThrow(ConfigError);
  });
});

describe("loadWorkerConfig", () => {
  it("defaults to the local stack and requires explicit settings in production", async () => {
    const { loadWorkerConfig } = await import("./worker-config");
    const local = loadWorkerConfig({ ...ports });
    expect(local.queue).toEqual({ redisUrl: "redis://127.0.0.1:6379", prefix: "spatial" });
    expect(local.database.url).toBe("postgres://app_rw:app_rw_dev@127.0.0.1:6432/spatial");
    expect(() => loadWorkerConfig({ NODE_ENV: "production" })).toThrow(/REDIS_QUEUE_URL/);
    expect(() => loadWorkerConfig({ NODE_ENV: "production" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("runs Claude Opus 5.5 by default and local models only outside production (D12)", async () => {
    const { loadWorkerConfig } = await import("./worker-config");
    const local = loadWorkerConfig({ ...ports });
    expect(local.llm).toMatchObject({
      defaultProvider: "claude",
      models: { claude: "claude-opus-5-5", ollama: "qwen2.5vl-3b-48k" },
      localEnabled: true,
      localBaseUrl: "http://127.0.0.1:11434/v1",
      anthropic: { fallbackModel: "claude-sonnet-5", refusalFallbacks: true },
    });
    expect(() => loadWorkerConfig({ NODE_ENV: "production", LLM_LOCAL_ENABLED: "true" })).toThrow(
      /development-only/,
    );
    expect(() => loadApiConfig({ NODE_ENV: "production", LLM_DEFAULT_PROVIDER: "ollama" })).toThrow(
      /must be claude in production/,
    );
  });
});
