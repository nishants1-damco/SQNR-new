// Runs one fixture capture through the real pipeline: a throwaway database,
// frames in an in-memory blob store, and whichever provider the caller gives.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, type DatabaseHandle } from "@spatial/db";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import {
  AnalysisRunError,
  AnalysisStore,
  CatalogSource,
  type Effort,
  type LlmProvider,
  runAnalysis,
  silentLogger,
  type UsageSummary,
} from "@spatial/pipeline";
import { MemoryBlobStore } from "@spatial/storage";
import { sql } from "drizzle-orm";
import jpeg from "jpeg-js";
import type { Actual, Capture } from "./fixtures";

/** A plain grey frame for synthetic captures. */
function blankFrame(shade: number): Uint8Array {
  const width = 96;
  const height = 72;
  const data = new Uint8Array(width * height * 4).fill(shade);
  return new Uint8Array(jpeg.encode({ width, height, data }, 80).data);
}

export class CaptureRunner {
  private constructor(
    private readonly database: TestDatabase,
    private readonly handle: DatabaseHandle,
  ) {}

  static async start(): Promise<CaptureRunner> {
    const database = await createTestDatabase();
    return new CaptureRunner(database, createDatabase({ url: database.appUrl, max: 4 }));
  }

  async close() {
    await this.handle.close();
    await this.database.drop();
  }

  async run(
    capture: { dir: string; capture: Capture },
    provider: LlmProvider,
    options: { effort?: Partial<Record<string, Effort>> } = {},
  ): Promise<{ actual: Actual | null; usage: UsageSummary; error: string | null }> {
    const db = this.handle.db;
    const blobs = new MemoryBlobStore();
    const c = capture.capture;
    const userId = (
      await db.execute<{ id: string }>(
        sql`INSERT INTO users (email) VALUES (${`eval-${randomUUID()}@example.test`}) RETURNING id`,
      )
    ).rows[0]!.id;
    const analysisId = randomUUID();
    const scanId = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO scans (user_id, name, notes, status, acoustics, analysis_notes, depth_metrics, depth_source)
        VALUES (${userId}, ${c.name}, ${c.notes ?? null}, 'processing',
          ${JSON.stringify(c.acoustics ?? {})}::jsonb,
          ${JSON.stringify({ ...c.analysis_notes, analysis_id: analysisId })}::jsonb,
          ${JSON.stringify(c.depth_metrics ?? {})}::jsonb, ${c.depth_source ?? null})
        RETURNING id`)
    ).rows[0]!.id;
    for (const [i, photo] of c.photos.entries()) {
      const key = `${userId}/${scanId}/frames/${i}.jpg`;
      const bytes = photo.file
        ? new Uint8Array(readFileSync(join(capture.dir, "frames", photo.file)))
        : blankFrame(60 + ((i * 37) % 150));
      await blobs.put(key, bytes, "image/jpeg");
      await db.execute(sql`
        INSERT INTO scan_photos (scan_id, user_id, storage_path, heading_deg, idx, captured_at, sensor_payload)
        VALUES (${scanId}, ${userId}, ${key}, ${photo.heading_deg}, ${i},
          ${photo.captured_at ?? new Date(Date.UTC(2026, 0, 1, 12, 0, i)).toISOString()}::timestamptz,
          ${JSON.stringify(photo.sensor_payload ?? {})}::jsonb)`);
    }
    await db.execute(sql`
      INSERT INTO scan_analyses (id, scan_id, user_id, provider, model_version, prompt_version, status)
      VALUES (${analysisId}, ${scanId}, ${userId}, ${provider.kind}, ${provider.primaryModel}, 'eval', 'queued')`);

    const store = new AnalysisStore(db);
    const catalog = new CatalogSource({
      db,
      embedder: null,
      logger: silentLogger,
      imageOrigins: [],
    });
    try {
      const outcome = await runAnalysis(
        {
          store,
          blobs,
          provider,
          catalog,
          logger: silentLogger,
          // Offline and live runs alike: always review, as a queued job can afford it.
          reviewBudgetMs: Number.MAX_SAFE_INTEGER,
          ...(options.effort ? { effort: options.effort } : {}),
        },
        { analysisId, scanId, userId },
      );
      if (outcome.status !== "succeeded") {
        throw new Error(`analysis ${outcome.status}: ${outcome.reason}`);
      }
      return { actual: await this.actual(scanId), usage: outcome.usage, error: null };
    } catch (err) {
      const usage = err instanceof AnalysisRunError ? err.usage : null;
      const message = err instanceof Error ? err.message : String(err);
      return { actual: null, usage: usage ?? emptyUsage(), error: message };
    }
  }

  private async actual(scanId: string): Promise<Actual> {
    const db = this.handle.db;
    const scan = (
      await db.execute<{ width_m: number; length_m: number; height_m: number }>(sql`
        SELECT width_m::float8 AS width_m, length_m::float8 AS length_m, height_m::float8 AS height_m
        FROM scans WHERE id = ${scanId}`)
    ).rows[0]!;
    const objects = await db.execute<{ label: string; category: string; width_m: number }>(sql`
      SELECT label, category, width_m::float8 AS width_m FROM scan_objects WHERE scan_id = ${scanId}`);
    const portals = await db.execute<{ kind: string; wall: string; width_m: number }>(sql`
      SELECT kind, wall, width_m::float8 AS width_m FROM scan_portals WHERE scan_id = ${scanId}`);
    return { ...scan, objects: objects.rows, portals: portals.rows };
  }
}

function emptyUsage(): UsageSummary {
  return {
    calls: 0,
    failed_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    estimated_cost_usd: 0,
    fallback_served: 0,
    by_step: {},
  };
}
