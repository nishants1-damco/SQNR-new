import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checksum, MigrationError, readMigrations } from "./migrator";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spatial-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("readMigrations", () => {
  it("orders migrations by file name and detects no-transaction files", () => {
    const dir = dirWith({
      "0002_second.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON t (c);",
      "0001_first.sql": "CREATE TABLE t (c int);",
      "README.md": "ignored",
    });
    const migrations = readMigrations(dir);
    expect(migrations.map((m) => [m.id, m.transactional])).toEqual([
      ["0001_first", true],
      ["0002_second", false],
    ]);
  });

  it("rejects badly named files instead of silently skipping them", () => {
    const dir = dirWith({ "1_first.sql": "SELECT 1;" });
    expect(() => readMigrations(dir)).toThrow(MigrationError);
  });

  it("ships the baseline migrations in order", () => {
    expect(readMigrations().map((m) => m.id)).toEqual([
      "0001_identity",
      "0002_spatial",
      "0003_reference_data",
      "0004_uploads_and_outbox",
      "0005_analysis_runs",
      "0006_spend_index",
    ]);
  });
});

describe("checksum", () => {
  it("ignores Windows line endings so checkouts on any OS agree", () => {
    expect(checksum("SELECT 1;\r\nSELECT 2;\r\n")).toBe(checksum("SELECT 1;\nSELECT 2;\n"));
    expect(checksum("SELECT 1;")).not.toBe(checksum("SELECT 2;"));
  });
});
