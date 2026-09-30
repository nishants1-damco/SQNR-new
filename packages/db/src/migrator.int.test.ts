import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, MigrationError, readMigrations } from "./migrator";
import { createTestDatabase, type TestDatabase } from "./testing";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database?.drop();
});

describe("migrate", () => {
  it("applies every migration to an empty database, in order", async () => {
    const result = await migrate({ databaseUrl: database.migratorUrl });
    expect(result.applied).toEqual(readMigrations().map((m) => m.id));
    expect(result.alreadyApplied).toEqual([]);
  });

  it("is a no-op when everything is applied", async () => {
    const result = await migrate({ databaseUrl: database.migratorUrl });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toHaveLength(readMigrations().length);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const admin = new pg.Client({ connectionString: database.adminUrl });
    await admin.connect();
    try {
      await admin.query(
        "UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '0001_identity'",
      );
      await expect(migrate({ databaseUrl: database.migratorUrl })).rejects.toThrow(MigrationError);
      await expect(migrate({ databaseUrl: database.migratorUrl })).rejects.toThrow(/was edited/);
    } finally {
      const [first] = readMigrations();
      await admin.query("UPDATE schema_migrations SET checksum = $1 WHERE id = '0001_identity'", [
        first?.checksum,
      ]);
      await admin.end();
    }
  });
});
