// Local-stack settings for the dev-infra scripts, from the shared
// @spatial/config helper (which reads infra/docker/.env like Compose does).
import { LOCAL_DATABASE, LOCAL_ROLES, localStack } from "@spatial/config";

const stack = localStack();

export const config = {
  postgres: {
    host: "127.0.0.1",
    port: stack.ports.postgres,
    database: LOCAL_DATABASE,
    appUser: LOCAL_ROLES.app,
    migratorUser: LOCAL_ROLES.migrator,
  },
  pgbouncerPort: stack.ports.pgbouncer,
  redisUrl: stack.redisUrl,
  blob: {
    ...stack.blob,
    /** Containers from the migration plan §12.1. `public` = anonymous read. */
    containers: [
      { name: "scans", public: false },
      { name: "exports", public: false },
      { name: "catalog-images", public: true },
    ],
  },
  /** Origins the browser uploads from (the future apps/web dev server). */
  webOrigins: (process.env["WEB_ORIGINS"] ?? "http://localhost:5173").split(","),
  mailpit: { smtpPort: stack.ports.mailpitSmtp, apiUrl: stack.mailpitApiUrl },
  ollamaUrl: stack.ollamaUrl,
};
