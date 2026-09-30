// The checkpointed runner end to end against a real database, with frames in
// an in-memory blob store and a scripted model: a crash mid-run resumes from
// its checkpoints without paying for finished passes again, and a finished
// run is written in one go.
import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseHandle } from "@spatial/db";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import { MemoryBlobStore } from "@spatial/storage";
import { sql } from "drizzle-orm";
import { encode } from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogSource } from "./catalog";
import { LlmError } from "./llm/errors";
import { ScriptedProvider } from "./llm/scripted";
import { silentLogger } from "./logger";
import { runPrivacyPurge } from "./privacy";
import { AnalysisRunError, runAnalysis } from "./runner";
import { AnalysisStore, type RunRef } from "./store";
import type { AnalysisResult } from "./types";

let database: TestDatabase;
let handle: DatabaseHandle;
let store: AnalysisStore;

beforeAll(async () => {
  database = await createTestDatabase();
  handle = createDatabase({ url: database.appUrl, max: 4 });
  store = new AnalysisStore(handle.db);
});

afterAll(async () => {
  await handle?.close();
  await database?.drop();
});

function jpeg(shade: number): Uint8Array {
  const width = 64;
  const height = 48;
  const data = new Uint8Array(width * height * 4).fill(shade);
  return new Uint8Array(encode({ width, height, data }, 80).data);
}

const RECONSTRUCTION: AnalysisResult = {
  name: "Living room",
  summary: "A rectangular living room.",
  width_m: 4,
  length_m: 5,
  height_m: 2.6,
  scale_reference: "door leaf",
  wall_evidence: [],
  objects: [
    {
      label: "Sofa",
      category: "seating",
      confidence: 0.9,
      x_m: 0,
      y_m: 2,
      width_m: 2,
      depth_m: 0.9,
      height_m: 0.8,
      against_wall: "north",
      wall_offset_m: 2,
      supporting_headings_deg: [0],
    },
  ],
  surfaces: [],
  portals: [
    {
      kind: "door",
      wall: "south",
      offset_m: 0.5,
      width_m: 0.9,
      height_m: 2.03,
      sill_m: 0,
      confidence: 0.9,
      notes: "",
    },
  ],
};

const replies = (overrides: Record<string, unknown> = {}) => ({
  "people-screen": { frames_with_people: [1] },
  inventory: { objects: [{ ...RECONSTRUCTION.objects[0], frame_boxes: [] }] },
  landmarks: { sightings: [] },
  reconstruction: RECONSTRUCTION,
  review: { ...RECONSTRUCTION, revision_notes: ["checked"] },
  ...overrides,
});

/** A user, a scan with three frames, and a claimed run, as the API leaves them. */
async function claimedScan(blobs: MemoryBlobStore): Promise<RunRef & { paths: string[] }> {
  const db = handle.db;
  const { rows: users } = await db.execute<{ id: string }>(
    sql`INSERT INTO users (email) VALUES (${`${randomUUID()}@example.com`}) RETURNING id`,
  );
  const userId = users[0]!.id;
  const analysisId = randomUUID();
  const { rows: scans } = await db.execute<{ id: string }>(sql`
    INSERT INTO scans (user_id, name, status, analysis_notes)
    VALUES (${userId}, 'Lounge', 'processing', ${JSON.stringify({
      analysis_id: analysisId,
      started_at: new Date().toISOString(),
    })}::jsonb) RETURNING id`);
  const scanId = scans[0]!.id;
  const paths: string[] = [];
  for (let i = 0; i < 3; i++) {
    const path = `${userId}/${scanId}/frames/${i}.jpg`;
    await blobs.put(path, jpeg(40 + i * 60), "image/jpeg");
    await db.execute(sql`
      INSERT INTO scan_photos (scan_id, user_id, storage_path, heading_deg, idx)
      VALUES (${scanId}, ${userId}, ${path}, ${i * 120}, ${i})`);
    paths.push(path);
  }
  await db.execute(sql`
    INSERT INTO scan_analyses (id, scan_id, user_id, provider, model_version, prompt_version, status)
    VALUES (${analysisId}, ${scanId}, ${userId}, 'claude', 'scripted-model', 'recon-v6', 'queued')`);
  return { analysisId, scanId, userId, paths };
}

const catalog = () =>
  new CatalogSource({ db: handle.db, embedder: null, logger: silentLogger, imageOrigins: [] });

describe("runAnalysis", () => {
  it("resumes from its checkpoints after a failure and writes the result in one go", async () => {
    const blobs = new MemoryBlobStore();
    const run = await claimedScan(blobs);

    const failing = new ScriptedProvider(
      replies({
        reconstruction: () => {
          throw new LlmError("provider_unavailable", "AI analysis failed (529)");
        },
      }),
    );
    const first = runAnalysis(
      { store, blobs, provider: failing, catalog: catalog(), logger: silentLogger },
      run,
    );
    await expect(first).rejects.toBeInstanceOf(AnalysisRunError);
    const stages = (
      await handle.db.execute<{ stage: string }>(
        sql`SELECT stage FROM analysis_checkpoints WHERE analysis_id = ${run.analysisId} ORDER BY stage`,
      )
    ).rows.map((r) => r.stage);
    expect(stages).toEqual(["calls:1", "catalog", "detect", "load", "verify"]);

    const working = new ScriptedProvider(replies());
    const outcome = await runAnalysis(
      { store, blobs, provider: working, catalog: catalog(), logger: silentLogger },
      run,
    );
    expect(outcome).toMatchObject({ status: "succeeded", objects: 1, portals: 1 });
    if (outcome.status !== "succeeded") return;
    expect(outcome.resumedStages).toEqual(["load", "detect", "catalog", "verify"]);
    // Detection was not paid for twice.
    expect(working.steps()).toEqual(["reconstruction", "review"]);
    // Usage covers both attempts, including the failed reconstruction call.
    expect(outcome.usage.by_step["reconstruction"]?.calls).toBe(2);
    expect(outcome.usage.failed_calls).toBe(1);

    const db = handle.db;
    const scan = (
      await db.execute<{
        status: string;
        width_m: string;
        provider: string;
        prompt_version: string;
        notes: Record<string, unknown>;
      }>(sql`
        SELECT status, width_m, provider, prompt_version, analysis_notes AS notes
        FROM scans WHERE id = ${run.scanId}`)
    ).rows[0]!;
    expect(scan).toMatchObject({ status: "ready", width_m: "4", provider: "claude" });
    expect(scan.prompt_version).toBe("recon-v6");
    expect(scan.notes).toMatchObject({ stage: "done", critiqued: true, privacy_frames_removed: 1 });
    expect(scan.notes["frame_removals"]).toHaveLength(1);

    const counts = (
      await db.execute<Record<string, number>>(sql`
        SELECT
          (SELECT count(*)::int FROM scan_objects WHERE scan_id = ${run.scanId}) AS objects,
          (SELECT count(*)::int FROM scan_portals WHERE scan_id = ${run.scanId}) AS portals,
          (SELECT count(*)::int FROM scan_surfaces WHERE scan_id = ${run.scanId}) AS surfaces,
          (SELECT count(*)::int FROM scan_nav_nodes WHERE scan_id = ${run.scanId}) AS nodes,
          (SELECT count(*)::int FROM scan_nav_edges WHERE scan_id = ${run.scanId}) AS edges,
          (SELECT count(*)::int FROM scan_layers WHERE scan_id = ${run.scanId}) AS layers,
          (SELECT count(*)::int FROM scan_photos WHERE scan_id = ${run.scanId}) AS photos,
          (SELECT count(*)::int FROM scan_photos
            WHERE scan_id = ${run.scanId} AND camera_pose IS NOT NULL) AS posed,
          (SELECT count(*)::int FROM analysis_checkpoints
            WHERE analysis_id = ${run.analysisId}) AS checkpoints`)
    ).rows[0];
    expect(counts).toEqual({
      objects: 1,
      portals: 1,
      // Floor, ceiling and four walls synthesised from the shell.
      surfaces: 6,
      nodes: 2,
      edges: 1,
      layers: 6,
      // The frame with a person in it is gone...
      photos: 2,
      posed: 2,
      checkpoints: 0,
    });
    // ...and its file is queued for deletion.
    const outbox = await db.execute<{ payload: { keys: string[] } }>(
      sql`SELECT payload FROM outbox WHERE topic = 'blob.delete'`,
    );
    expect(outbox.rows.flatMap((r) => r.payload.keys)).toContain(run.paths[1]);

    const analysis = (
      await db.execute<{ status: string; attempts: number; cost: string; frames: number }>(sql`
        SELECT status, attempts, cost_estimate_usd AS cost, input_frame_count AS frames
        FROM scan_analyses WHERE id = ${run.analysisId}`)
    ).rows[0];
    expect(analysis).toMatchObject({ status: "succeeded", attempts: 2, frames: 3 });
  });

  it("does nothing when the run no longer owns its scan", async () => {
    const blobs = new MemoryBlobStore();
    const run = await claimedScan(blobs);
    // A newer claim (or the stalled-scan sweep) took the scan over.
    await handle.db.execute(sql`
      UPDATE scans SET analysis_notes = analysis_notes || '{"analysis_id":"someone-else"}'::jsonb
      WHERE id = ${run.scanId}`);
    const provider = new ScriptedProvider(replies());
    const outcome = await runAnalysis(
      { store, blobs, provider, catalog: catalog(), logger: silentLogger },
      run,
    );
    expect(outcome).toEqual({ status: "skipped", reason: "scan no longer owned by this run" });
    expect(provider.requests).toHaveLength(0);
    const status = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM scan_analyses WHERE id = ${run.analysisId}`,
    );
    expect(status.rows[0]?.status).toBe("failed");
  });

  it("fails permanently when no frame can be loaded", async () => {
    const blobs = new MemoryBlobStore();
    const run = await claimedScan(blobs);
    await blobs.deletePrefix(`${run.userId}/`);
    const provider = new ScriptedProvider(replies());
    const failure = await runAnalysis(
      { store, blobs, provider, catalog: catalog(), logger: silentLogger },
      run,
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AnalysisRunError);
    expect((failure as AnalysisRunError).cause).toMatchObject({
      code: "no_frames",
      retryable: false,
    });

    await store.failRun(run, { code: "no_frames", message: "No photos available", usage: null });
    const rows = await handle.db.execute<{ scan: string; run: string; error: string }>(sql`
      SELECT s.status AS scan, a.status AS run, s.analysis_notes->>'error' AS error
      FROM scans s JOIN scan_analyses a ON a.scan_id = s.id WHERE a.id = ${run.analysisId}`);
    expect(rows.rows[0]).toEqual({ scan: "failed", run: "failed", error: "No photos available" });
  });
});

describe("runPrivacyPurge", () => {
  it("removes frames with people and records the sweep", async () => {
    const blobs = new MemoryBlobStore();
    const run = await claimedScan(blobs);
    const provider = new ScriptedProvider({ "people-screen": { frames_with_people: [0, 2] } });
    const result = await runPrivacyPurge(
      { store, blobs, provider, logger: silentLogger },
      { scanId: run.scanId, userId: run.userId, requestedAt: new Date().toISOString() },
    );
    expect(result).toMatchObject({ scanned: 3, removed: 2 });
    const notes = await handle.db.execute<{ sweep: Record<string, unknown>; photos: number }>(sql`
      SELECT analysis_notes->'privacy_sweep' AS sweep,
        (SELECT count(*)::int FROM scan_photos WHERE scan_id = ${run.scanId}) AS photos
      FROM scans WHERE id = ${run.scanId}`);
    expect(notes.rows[0]).toMatchObject({ photos: 1, sweep: { status: "done", removed: 2 } });
  });

  it("fails instead of reporting no people when the model can't be reached", async () => {
    const blobs = new MemoryBlobStore();
    const run = await claimedScan(blobs);
    const provider = new ScriptedProvider({
      "people-screen": () => {
        throw new LlmError("rate_limited", "AI rate limit reached. Try again in a moment.");
      },
    });
    await expect(
      runPrivacyPurge(
        { store, blobs, provider, logger: silentLogger },
        { scanId: run.scanId, userId: run.userId, requestedAt: new Date().toISOString() },
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
