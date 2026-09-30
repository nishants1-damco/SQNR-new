// The migrated database against the Drizzle schema (drift test), plus the
// behaviour of the SQL ported from Supabase.
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let database: TestDatabase;
let app: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  app = new pg.Client({ connectionString: database.appUrl });
  admin = new pg.Client({ connectionString: database.adminUrl });
  await Promise.all([app.connect(), admin.connect()]);
});

afterAll(async () => {
  await Promise.all([app?.end(), admin?.end()]);
  await database?.drop();
});

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

/** "geometry(Polygon, 0)" and "geometry(Polygon)" are the same type. */
const normalizeType = (type: string) =>
  type
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/,0\)$/, ")")
    .replace(/^timestamp\(\d\)/, "timestamp");

describe("schema drift", () => {
  it("has a Drizzle table for every migrated table and nothing extra", async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name NOT IN ('schema_migrations', 'spatial_ref_sys')`,
    );
    const inDatabase = rows.map((r) => r.table_name).sort();
    const inDrizzle = tables.map((t) => getTableConfig(t).name).sort();
    expect(inDrizzle).toEqual(inDatabase);
  });

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
    "%s: columns, types and nullability match",
    async (name, table) => {
      const { rows } = await admin.query<{ column: string; type: string; not_null: boolean }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null
         FROM pg_attribute a
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attname`,
        [`public.${name}`],
      );
      const actual = rows.map((r) => ({
        column: r.column,
        type: normalizeType(r.type),
        notNull: r.not_null,
      }));
      const expected = getTableConfig(table)
        .columns.map((c) => ({
          column: c.name,
          type: normalizeType(c.getSQLType()),
          notNull: c.notNull,
        }))
        .sort((a, b) => a.column.localeCompare(b.column));
      expect(expected).toEqual(actual);
    },
  );
});

describe("roles", () => {
  it("lets the app role read and write but not change the schema", async () => {
    await expect(app.query("SELECT count(*) FROM users")).resolves.toBeTruthy();
    await expect(app.query("CREATE TABLE nope (id int)")).rejects.toThrow(/permission denied/);
    await expect(app.query("ALTER TABLE users ADD COLUMN nope int")).rejects.toThrow(
      /must be owner/,
    );
  });
});

async function createUser(email: string): Promise<string> {
  const { rows } = await app.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email],
  );
  return rows[0]!.id;
}

describe("users", () => {
  it("treats email as case-insensitive and unique", async () => {
    await createUser("Case@Example.com");
    await expect(createUser("case@example.COM")).rejects.toThrow(/duplicate key/);
    const { rows } = await app.query("SELECT id FROM users WHERE email = 'CASE@EXAMPLE.COM'");
    expect(rows).toHaveLength(1);
  });

  it("maintains updated_at on every update", async () => {
    const id = await createUser("updated@example.com");
    const before = await app.query<{ updated_at: Date }>(
      "SELECT updated_at FROM users WHERE id = $1",
      [id],
    );
    await new Promise((r) => setTimeout(r, 20));
    await app.query("UPDATE users SET last_sign_in_at = now() WHERE id = $1", [id]);
    const after = await app.query<{ updated_at: Date }>(
      "SELECT updated_at FROM users WHERE id = $1",
      [id],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]!.updated_at.getTime(),
    );
  });

  it("removes a user's scans and their children when the user is deleted", async () => {
    const id = await createUser("cascade@example.com");
    const scan = await app.query<{ id: string }>(
      "INSERT INTO scans (user_id, name) VALUES ($1, 'Kitchen') RETURNING id",
      [id],
    );
    const scanId = scan.rows[0]!.id;
    await app.query(
      "INSERT INTO scan_photos (scan_id, user_id, storage_path) VALUES ($1, $2, 'a/b/frame-0.jpg')",
      [scanId, id],
    );
    await app.query(
      `INSERT INTO scan_nav_nodes (scan_id, user_id, point) VALUES ($1, $2, ST_MakePoint(0, 0, 0))`,
      [scanId, id],
    );
    await app.query("DELETE FROM users WHERE id = $1", [id]);
    for (const table of ["scans", "scan_photos", "scan_nav_nodes"]) {
      const { rows } = await app.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [id]);
      expect(rows, table).toHaveLength(0);
    }
  });
});

describe("consume_rate_limit", () => {
  it("allows up to the maximum in a window, then reports when to retry", async () => {
    const id = await createUser("limits@example.com");
    const call = () =>
      app.query<{ allowed: boolean; remaining: number; retry_after_ms: string }>(
        "SELECT * FROM consume_rate_limit($1, 'analyze_scan', 60000, 2)",
        [id],
      );
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await call()).rows[0]!);
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([1, 0, 0]);
    expect(Number(results[2]!.retry_after_ms)).toBeGreaterThan(0);
  });
});

describe("scan_export", () => {
  it("exports only the owner's scan", async () => {
    const owner = await createUser("export-owner@example.com");
    const other = await createUser("export-other@example.com");
    const scan = await app.query<{ id: string }>(
      `INSERT INTO scans (user_id, name, footprint)
       VALUES ($1, 'Office', ST_GeomFromText('POLYGON((0 0, 4 0, 4 3, 0 3, 0 0))', 0))
       RETURNING id`,
      [owner],
    );
    const scanId = scan.rows[0]!.id;
    const exportFor = async (userId: string) =>
      (
        await app.query<{ bundle: Record<string, unknown> | null }>(
          "SELECT scan_export($1, $2) AS bundle",
          [scanId, userId],
        )
      ).rows[0]!.bundle;

    const bundle = await exportFor(owner);
    expect(bundle).not.toBeNull();
    const features = (bundle!["geojson"] as { features: { id: string }[] }).features;
    expect(features.map((f) => f.id)).toContain(`scan:${scanId}`);
    expect(await exportFor(other)).toBeNull();
  });
});

describe("product catalog", () => {
  it("ships the reference rows and matches by embedding", async () => {
    const { rows } = await app.query<{ count: string }>("SELECT count(*) FROM product_dimensions");
    expect(Number(rows[0]!.count)).toBe(37);

    const vector = (hot: number) =>
      JSON.stringify(Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0)));
    await app.query("UPDATE product_dimensions SET embedding = $1 WHERE label LIKE 'BenQ%'", [
      vector(0),
    ]);
    await app.query("UPDATE product_dimensions SET embedding = $1 WHERE label LIKE 'Xiaomi%'", [
      vector(1),
    ]);
    const match = await app.query<{ label: string; similarity: number }>(
      "SELECT label, similarity FROM match_product_catalog($1, 1)",
      [vector(0)],
    );
    expect(match.rows[0]?.label).toMatch(/^BenQ/);
    expect(match.rows[0]?.similarity).toBeCloseTo(1);
  });
});
