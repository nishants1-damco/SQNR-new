// Database access for apps/api and apps/worker: a node-postgres pool (through
// PgBouncer in transaction mode) wrapped by Drizzle.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
/** A Drizzle handle inside `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  pool: pg.Pool;
  db: Database;
  close(): Promise<void>;
}

export function createDatabase(options: {
  url: string;
  /** Per-process pool size. Keep small: PgBouncer multiplexes (plan §8.4). */
  max?: number;
  applicationName?: string;
  /** How long a query waits for a free connection before failing. */
  connectionTimeoutMs?: number;
}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "spatial",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}
