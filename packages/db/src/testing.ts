// Throwaway databases for integration tests (migration plan §18.1). Each test
// run gets its own database on the local stack's Postgres, bootstrapped with
// the same SQL as `spatial` (extensions + privileges) and fully migrated, so
// tests never share state and never touch the development database.
//
// Requires the local stack (`pnpm infra:up`). Development and CI only.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, localStack } from "@spatial/config";
import pg from "pg";
import { migrate } from "./migrator";

export interface TestDatabase {
  name: string;
  /** app_rw through PgBouncer, as the API connects. */
  appUrl: string;
  /** app_migrator, directly. */
  migratorUrl: string;
  /** Superuser, directly. For assertions that need to see everything. */
  adminUrl: string;
  drop(): Promise<void>;
}

const PREFIX = "spatial_test_";
/** Leftovers from crashed runs older than this are dropped on the next run. */
const STALE_AFTER_MS = 60 * 60 * 1000;

function bootstrapSql(): string {
  const root = findRepoRoot();
  if (!root) throw new Error("Cannot find the repository root (pnpm-workspace.yaml)");
  const dir = join(root, "infra", "docker", "postgres", "initdb");
  return ["10-extensions.sql", "30-database-privileges.sql"]
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}

async function withAdmin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "spatial-test-admin" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropStale(adminUrl: string) {
  await withAdmin(adminUrl, async (admin) => {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE $1",
      [`${PREFIX}%`],
    );
    for (const { datname } of rows) {
      const created = Number(datname.slice(PREFIX.length).split("_")[0]);
      if (Number.isFinite(created) && Date.now() - created > STALE_AFTER_MS) {
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    }
  });
}

export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `${PREFIX}${Date.now()}_${randomBytes(4).toString("hex")}`;
  const server = localStack();
  await dropStale(server.adminDatabaseUrl);
  await withAdmin(server.adminDatabaseUrl, (admin) => admin.query(`CREATE DATABASE "${name}"`));

  const stack = localStack({ database: name });
  await withAdmin(stack.adminDatabaseUrl, (admin) => admin.query(bootstrapSql()));
  if (options.migrate !== false) await migrate({ databaseUrl: stack.migratorDatabaseUrl });

  return {
    name,
    appUrl: stack.appDatabaseUrl,
    migratorUrl: stack.migratorDatabaseUrl,
    adminUrl: stack.adminDatabaseUrl,
    drop: () =>
      withAdmin(server.adminDatabaseUrl, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      ).then(() => undefined),
  };
}
