// Analysis jobs through the real worker: an outbox row in, a finished scan
// out, with a scripted model standing in for Claude. Also the failure path,
// the stalled-scan sweep and the privacy sweep.
import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { loadWorkerConfig, type WorkerConfig } from "@spatial/config";
import { analysisEventsChannel } from "@spatial/contracts";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import { LlmError, ScriptedProvider } from "@spatial/pipeline";
import { type AzureBlobStore, blobStoreFromSettings } from "@spatial/storage";
import { Redis } from "ioredis";
import jpeg from "jpeg-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { MaintenanceProcessor } from "../src/maintenance.processor";

let database: TestDatabase;
let config: WorkerConfig;
let worker: INestApplicationContext;
let blobs: AzureBlobStore;
let admin: pg.Client;
let subscriber: Redis;
let userId: string;

/** Replies by step; a test swaps in its own for one scan by name. */
let script: Record<string, unknown> = {};

const RECONSTRUCTION = {
  name: "Studio",
  summary: "A small studio.",
  width_m: 3.5,
  length_m: 4,
  height_m: 2.5,
  scale_reference: "door",
  wall_evidence: [],
  objects: [
    {
      label: "Desk",
      category: "table",
      confidence: 0.9,
      x_m: 0,
      y_m: 1.6,
      width_m: 1.4,
      depth_m: 0.7,
      height_m: 0.75,
      against_wall: "north",
      wall_offset_m: 1.75,
      supporting_headings_deg: [0],
    },
  ],
  surfaces: [],
  portals: [
    {
      kind: "door",
      wall: "east",
      offset_m: 1,
      width_m: 0.9,
      height_m: 2.03,
      sill_m: 0,
      confidence: 0.9,
      notes: "",
    },
  ],
};

const defaultScript = () => ({
  "people-screen": { frames_with_people: [] },
  inventory: { objects: [] },
  landmarks: { sightings: [] },
  reconstruction: RECONSTRUCTION,
  review: RECONSTRUCTION,
});

beforeAll(async () => {
  database = await createTestDatabase();
  config = loadWorkerConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env["TEST_LOG_LEVEL"] ?? "silent",
    DATABASE_URL: database.appUrl,
    QUEUE_PREFIX: `test:${database.name}`,
    BLOB_CONTAINER_SCANS: `test-${randomBytes(6).toString("hex")}`,
    OUTBOX_POLL_MS: "100",
    HEALTH_PORT: "0",
    ANALYSIS_ATTEMPTS: "2",
  });
  blobs = blobStoreFromSettings(config.blob, config.blob.containers.scans);
  await blobs.ensureContainer();
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  userId = (
    await admin.query("INSERT INTO users (email) VALUES ('analysis@example.test') RETURNING id")
  ).rows[0].id;
  subscriber = new Redis(config.queue.redisUrl);
  worker = await createWorker(config, {
    providers: {
      create: (kind, model) => new ScriptedProvider(script, { kind, model: model ?? "m" }),
    },
  });
});

afterAll(async () => {
  await worker?.close();
  await subscriber?.quit();
  await admin?.end();
  await blobs?.container.deleteIfExists();
  await database?.drop();
});

async function eventually<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function frame(shade: number): Uint8Array {
  const data = new Uint8Array(64 * 48 * 4).fill(shade);
  return new Uint8Array(jpeg.encode({ width: 64, height: 48, data }, 80).data);
}

/** A scan with frames, claimed and queued the way the API does it. */
async function queuedScan(frames = 2, notes: Record<string, unknown> = {}) {
  const analysisId = randomUUID();
  const scanId = (
    await admin.query(
      `INSERT INTO scans (user_id, status, analysis_notes) VALUES ($1, 'processing', $2) RETURNING id`,
      [
        userId,
        JSON.stringify({
          analysis_id: analysisId,
          started_at: new Date().toISOString(),
          deadline_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          stage: "queued",
          ...notes,
        }),
      ],
    )
  ).rows[0].id as string;
  const paths: string[] = [];
  for (let i = 0; i < frames; i++) {
    const key = `${userId}/${scanId}/frames/${i}.jpg`;
    await blobs.put(key, frame(50 + i * 50), "image/jpeg");
    await admin.query(
      `INSERT INTO scan_photos (scan_id, user_id, storage_path, heading_deg, idx) VALUES ($1, $2, $3, $4, $5)`,
      [scanId, userId, key, i * 90, i],
    );
    paths.push(key);
  }
  await admin.query(
    `INSERT INTO scan_analyses (id, scan_id, user_id, provider, model_version, prompt_version, status)
     VALUES ($1, $2, $3, 'claude', 'claude-opus-5-5', 'recon-v6', 'queued')`,
    [analysisId, scanId, userId],
  );
  return { analysisId, scanId, paths };
}

const enqueue = (topic: string, payload: unknown) =>
  admin.query("INSERT INTO outbox (topic, payload) VALUES ($1, $2)", [
    topic,
    JSON.stringify(payload),
  ]);

const scanRow = (scanId: string) =>
  admin
    .query(
      `SELECT s.status, s.analysis_notes AS notes,
         (SELECT row_to_json(a) FROM scan_analyses a WHERE a.scan_id = s.id
            ORDER BY a.created_at DESC LIMIT 1) AS run,
         (SELECT count(*)::int FROM scan_objects o WHERE o.scan_id = s.id) AS objects
       FROM scans s WHERE s.id = $1`,
      [scanId],
    )
    .then((r) => r.rows[0]);

describe("analysis jobs", () => {
  it("runs a queued analysis to a ready scan and publishes its progress", async () => {
    script = defaultScript();
    const { analysisId, scanId } = await queuedScan();
    const events: { stage: string }[] = [];
    await subscriber.subscribe(analysisEventsChannel(config.queue.prefix, scanId));
    subscriber.on("message", (_channel, message) => events.push(JSON.parse(message)));

    await enqueue("analysis.cloud", {
      analysisId,
      scanId,
      userId,
      provider: "claude",
      model: "claude-opus-5-5",
    });
    const row = await eventually(
      () => scanRow(scanId),
      (r) => r.status === "ready",
    );
    expect(row.objects).toBe(1);
    expect(row.run).toMatchObject({
      status: "succeeded",
      attempts: 1,
      model_version: "claude-opus-5-5",
    });
    expect(row.notes).toMatchObject({ stage: "done", progress_pct: 100 });
    await eventually(
      async () => events.map((e) => e.stage),
      (stages) => stages.includes("done"),
    );
    expect(events.map((e) => e.stage)).toEqual([
      "load",
      "detect",
      "catalog",
      "pass1",
      "pass2",
      "persist",
      "done",
    ]);
    await subscriber.unsubscribe();
  });

  it("fails the scan at once on an error a retry can't fix", async () => {
    script = {
      ...defaultScript(),
      reconstruction: () => {
        throw new LlmError("auth", "AI request rejected: check your cloud provider API key.");
      },
    };
    const { analysisId, scanId } = await queuedScan();
    await enqueue("analysis.cloud", {
      analysisId,
      scanId,
      userId,
      provider: "claude",
      model: "claude-opus-5-5",
    });
    const row = await eventually(
      () => scanRow(scanId),
      (r) => r.status === "failed",
    );
    expect(row.notes.error).toMatch(/API key/);
    expect(row.run).toMatchObject({ status: "failed", error_code: "auth", attempts: 1 });
  });

  it("retries a transient failure and resumes from the checkpoints", async () => {
    let failures = 0;
    script = {
      ...defaultScript(),
      reconstruction: () => {
        if (failures++ === 0)
          throw new LlmError("provider_unavailable", "AI analysis failed (529)");
        return RECONSTRUCTION;
      },
    };
    const { analysisId, scanId } = await queuedScan();
    await enqueue("analysis.cloud", {
      analysisId,
      scanId,
      userId,
      provider: "claude",
      model: "claude-opus-5-5",
    });
    // Backoff before the second attempt is 30 s; promote the delayed job.
    const { Queue } = await import("bullmq");
    const queue = new Queue("analysis-cloud", {
      connection: { url: config.queue.redisUrl },
      prefix: config.queue.prefix,
    });
    await eventually(
      async () => (await queue.getDelayed()).length,
      (n) => n > 0,
    );
    for (const job of await queue.getDelayed()) await job.promote();
    const row = await eventually(
      () => scanRow(scanId),
      (r) => r.status === "ready",
    );
    await queue.close();
    expect(row.run).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(row.run.metrics.resumed_stages).toEqual(["load", "detect", "catalog"]);
  });
});

describe("maintenance", () => {
  it("fails scans stuck past their deadline and times out their run", async () => {
    const { analysisId, scanId } = await queuedScan(1, {
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await worker.get(MaintenanceProcessor).sweepStalledScans();
    expect(result.swept).toBeGreaterThanOrEqual(1);
    const row = await scanRow(scanId);
    expect(row.status).toBe("failed");
    expect(row.notes).toMatchObject({ swept: true, stage: "failed" });
    expect(row.run).toMatchObject({ id: analysisId, status: "timed_out" });
  });
});

describe("privacy sweep jobs", () => {
  it("removes frames with people and records the sweep", async () => {
    script = { "people-screen": { frames_with_people: [1] } };
    const { scanId, paths } = await queuedScan(3);
    await admin.query(`UPDATE scans SET status = 'ready' WHERE id = $1`, [scanId]);
    await enqueue("privacy.purge", { scanId, userId, requestedAt: new Date().toISOString() });
    const row = await eventually(
      () => scanRow(scanId),
      (r) => r.notes.privacy_sweep?.status === "done",
    );
    expect(row.notes.privacy_sweep).toMatchObject({ scanned: 3, removed: 1 });
    // The removed frame's file is deleted by the blob-gc job.
    await eventually(
      () => blobs.head(paths[1]!),
      (head) => head === null,
    );
    expect(await blobs.head(paths[0]!)).not.toBeNull();
  });
});
