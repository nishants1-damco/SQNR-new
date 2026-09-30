// SQL-first migrations (migration plan §8.2). Plain .sql files in
// packages/db/migrations are applied in filename order, each in its own
// transaction, and recorded with a checksum. Editing a file that has already
// been applied is an error: write a new migration instead. Migrations must be
// backward compatible (expand/contract), because old and new API replicas run
// side by side during a rollout (plan §15).
//
// A file whose first line is `-- migrate:no-transaction` runs outside a
// transaction, for statements such as CREATE INDEX CONCURRENTLY.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** The migrations shipped with this package. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
/** Arbitrary constant: one migrator at a time per database. */
const LOCK_KEY = 72_310_401;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** SHA-256 of the file with line endings normalized, so Windows checkouts match. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const bad = files.filter((name) => !FILE_PATTERN.test(name));
  if (bad.length) {
    throw new MigrationError(
      `Migration file names must look like 0001_name.sql: ${bad.join(", ")}`,
    );
  }
  return files.map((name) => {
    const sql = readFileSync(join(dir, name), "utf8");
    return {
      id: name.replace(/\.sql$/, ""),
      sql,
      checksum: checksum(sql),
      transactional: !sql.startsWith("-- migrate:no-transaction"),
    };
  });
}

async function appliedMigrations(client: pg.Client): Promise<Map<string, string>> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )`);
  const { rows } = await client.query<{ id: string; checksum: string }>(
    "SELECT id, checksum FROM public.schema_migrations ORDER BY id",
  );
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

export async function migrate(options: {
  databaseUrl: string;
  dir?: string;
  log?: (message: string) => void;
}): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = readMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: "spatial-migrator",
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    const applied = await appliedMigrations(client);

    // Every recorded migration must still exist, unchanged.
    const known = new Map(migrations.map((m) => [m.id, m]));
    for (const [id, recorded] of applied) {
      const file = known.get(id);
      if (!file)
        throw new MigrationError(
          `Applied migration ${id} is missing from ${options.dir ?? MIGRATIONS_DIR}`,
        );
      if (file.checksum !== recorded) {
        throw new MigrationError(
          `Migration ${id} was edited after it was applied. Revert the edit and add a new migration instead.`,
        );
      }
    }

    const result: MigrateResult = { applied: [], alreadyApplied: [...applied.keys()] };
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      const started = Date.now();
      try {
        if (migration.transactional) await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO public.schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)",
          [migration.id, migration.checksum, Date.now() - started],
        );
        if (migration.transactional) await client.query("COMMIT");
      } catch (err) {
        if (migration.transactional) await client.query("ROLLBACK").catch(() => {});
        const reason = err instanceof Error ? err.message : String(err);
        throw new MigrationError(`Migration ${migration.id} failed: ${reason}`);
      }
      log(`applied ${migration.id} (${Date.now() - started} ms)`);
      result.applied.push(migration.id);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

/** Applied and pending migration ids, without changing anything. */
export async function migrationStatus(options: { databaseUrl: string; dir?: string }) {
  const migrations = readMigrations(options.dir);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    const applied = new Set<string>();
    if (exists.rows[0]?.present) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM public.schema_migrations",
      );
      for (const row of rows) applied.add(row.id);
    }
    return migrations.map((m) => ({ id: m.id, applied: applied.has(m.id) }));
  } finally {
    await client.end();
  }
}
