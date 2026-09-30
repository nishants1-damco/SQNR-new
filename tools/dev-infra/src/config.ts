// Connection settings for the local Docker stack. Ports follow
// infra/docker/.env when it exists (the same file Docker Compose reads), and
// fall back to the Compose defaults otherwise. Local development only: every
// credential here is a well-known dev value.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const composeEnv = fileURLToPath(new URL("../../../infra/docker/.env", import.meta.url));
if (existsSync(composeEnv)) process.loadEnvFile(composeEnv);

const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** Azurite's fixed development account (documented by Microsoft; not a secret). */
const AZURITE_ACCOUNT = "devstoreaccount1";
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const blobEndpoint = `http://127.0.0.1:${port("AZURITE_BLOB_PORT", 10000)}/${AZURITE_ACCOUNT}`;

export const config = {
  postgres: {
    host: "127.0.0.1",
    port: port("POSTGRES_PORT", 5432),
    database: "spatial",
    appUser: { user: "app_rw", password: "app_rw_dev" },
    migratorUser: { user: "app_migrator", password: "app_migrator_dev" },
  },
  pgbouncerPort: port("PGBOUNCER_PORT", 6432),
  redisUrl: `redis://127.0.0.1:${port("REDIS_PORT", 6379)}`,
  blob: {
    accountName: AZURITE_ACCOUNT,
    accountKey: AZURITE_KEY,
    endpoint: blobEndpoint,
    connectionString: `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};BlobEndpoint=${blobEndpoint};`,
    /** Containers from the migration plan §12.1. `public` = anonymous read. */
    containers: [
      { name: "scans", public: false },
      { name: "exports", public: false },
      { name: "catalog-images", public: true },
    ],
  },
  /** Origins the browser uploads from (the future apps/web dev server). */
  webOrigins: (process.env["WEB_ORIGINS"] ?? "http://localhost:5173").split(","),
  mailpit: {
    smtpPort: port("MAILPIT_SMTP_PORT", 1025),
    apiUrl: `http://127.0.0.1:${port("MAILPIT_UI_PORT", 8025)}/api/v1`,
  },
  ollamaUrl: `http://127.0.0.1:${port("OLLAMA_PORT", 11434)}`,
};
