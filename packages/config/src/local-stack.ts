// Connection settings for the local Docker stack (infra/docker). Ports come
// from infra/docker/.env when it exists — the same file Docker Compose reads —
// then from the process environment, then from the Compose defaults.
//
// Development and test only: every credential here is a well-known dev value,
// and `loadApiConfig` refuses to use these defaults in production.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

/** Walks up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function composeEnv(): Record<string, string | undefined> {
  const root = findRepoRoot();
  const file = root ? join(root, "infra", "docker", ".env") : null;
  return file && existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

/** Azurite's fixed development account, published by Microsoft; not a secret. */
export const AZURITE_ACCOUNT_NAME = "devstoreaccount1";
export const AZURITE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export const LOCAL_DATABASE = "spatial";
export const LOCAL_ROLES = {
  admin: { user: "postgres", password: "postgres" },
  migrator: { user: "app_migrator", password: "app_migrator_dev" },
  app: { user: "app_rw", password: "app_rw_dev" },
} as const;

export interface LocalStack {
  ports: {
    postgres: number;
    pgbouncer: number;
    redis: number;
    azuriteBlob: number;
    mailpitSmtp: number;
    mailpitUi: number;
    ollama: number;
  };
  /** Superuser connection, for creating test databases and extensions. */
  adminDatabaseUrl: string;
  /** Schema owner, connecting to Postgres directly (DDL needs a session). */
  migratorDatabaseUrl: string;
  /** Application role through PgBouncer, as the apps connect in production. */
  appDatabaseUrl: string;
  redisUrl: string;
  smtpUrl: string;
  mailpitApiUrl: string;
  blob: { accountName: string; accountKey: string; endpoint: string; connectionString: string };
  ollamaUrl: string;
}

function databaseUrl(
  role: { user: string; password: string },
  port: number,
  database: string,
): string {
  return `postgres://${role.user}:${role.password}@127.0.0.1:${port}/${database}`;
}

/** Local-stack URLs; `database` swaps in another database (tests use one per run). */
export function localStack(
  options: { database?: string; env?: Record<string, string | undefined> } = {},
): LocalStack {
  const env = { ...composeEnv(), ...(options.env ?? process.env) };
  const port = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a port number`);
    return value;
  };
  const ports = {
    postgres: port("POSTGRES_PORT", 5432),
    pgbouncer: port("PGBOUNCER_PORT", 6432),
    redis: port("REDIS_PORT", 6379),
    azuriteBlob: port("AZURITE_BLOB_PORT", 10000),
    mailpitSmtp: port("MAILPIT_SMTP_PORT", 1025),
    mailpitUi: port("MAILPIT_UI_PORT", 8025),
    ollama: port("OLLAMA_PORT", 11434),
  };
  const database = options.database ?? LOCAL_DATABASE;
  const blobEndpoint = `http://127.0.0.1:${ports.azuriteBlob}/${AZURITE_ACCOUNT_NAME}`;

  return {
    ports,
    adminDatabaseUrl: databaseUrl(LOCAL_ROLES.admin, ports.postgres, database),
    migratorDatabaseUrl: databaseUrl(LOCAL_ROLES.migrator, ports.postgres, database),
    appDatabaseUrl: databaseUrl(LOCAL_ROLES.app, ports.pgbouncer, database),
    redisUrl: `redis://127.0.0.1:${ports.redis}`,
    smtpUrl: `smtp://127.0.0.1:${ports.mailpitSmtp}`,
    mailpitApiUrl: `http://127.0.0.1:${ports.mailpitUi}/api/v1`,
    blob: {
      accountName: AZURITE_ACCOUNT_NAME,
      accountKey: AZURITE_ACCOUNT_KEY,
      endpoint: blobEndpoint,
      connectionString: `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT_NAME};AccountKey=${AZURITE_ACCOUNT_KEY};BlobEndpoint=${blobEndpoint};`,
    },
    ollamaUrl: `http://127.0.0.1:${ports.ollama}`,
  };
}
