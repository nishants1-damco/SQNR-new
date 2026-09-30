// The worker against the local stack: outbox rows in, real effects out
// (blobs deleted, frames checked, thumbnails written, sessions swept).
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import { loadWorkerConfig, type WorkerConfig } from "@spatial/config";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import { type AzureBlobStore, blobStoreFromSettings } from "@spatial/storage";
import jpeg from "jpeg-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorker } from "../src/app";
import { startHealthServer } from "../src/health";
import { MaintenanceProcessor } from "../src/maintenance.processor";
import { THUMBNAIL_EDGE_PX } from "../src/media.processor";

let database: TestDatabase;
let config: WorkerConfig;
let worker: INestApplicationContext;
let blobs: AzureBlobStore;
let admin: pg.Client;
let userId: string;
let scanId: string;

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
  });
  blobs = blobStoreFromSettings(config.blob, config.blob.containers.scans);
  await blobs.ensureContainer();
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  userId = (
    await admin.query("INSERT INTO users (email) VALUES ('worker@example.test') RETURNING id")
  ).rows[0].id;
  scanId = (await admin.query("INSERT INTO scans (user_id) VALUES ($1) RETURNING id", [userId]))
    .rows[0].id;
  worker = await createWorker(config);
});

afterAll(async () => {
  await worker?.close();
  await admin?.end();
  await blobs?.container.deleteIfExists();
  await database?.drop();
});

async function eventually<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const outbox = (topic: string, payload: unknown) =>
  admin.query("INSERT INTO outbox (topic, payload) VALUES ($1, $2)", [
    topic,
    JSON.stringify(payload),
  ]);

const bytes = (text: string) => new TextEncoder().encode(text);

async function addPhoto(
  key: string,
  body: Uint8Array,
  contentType = "image/jpeg",
): Promise<string> {
  await blobs.put(key, body, contentType);
  const { rows } = await admin.query(
    "INSERT INTO scan_photos (scan_id, user_id, storage_path) VALUES ($1, $2, $3) RETURNING id",
    [scanId, userId, key],
  );
  return rows[0].id;
}

/** A real JPEG with an EXIF (APP1) segment carrying a fake GPS marker. */
function jpegWithExif(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 0x80);
  const plain = new Uint8Array(jpeg.encode({ width, height, data }, 90).data);
  const exifBody = Buffer.from("Exif\0\0GPS-SECRET-LOCATION");
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([0, exifBody.length + 2]),
    exifBody,
  ]);
  return new Uint8Array(Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]));
}

describe("outbox relay + blob-gc", () => {
  it("deletes listed blobs and marks the outbox rows dispatched", async () => {
    const key = `${userId}/${scanId}/frames/doomed.jpg`;
    await blobs.put(key, bytes("x"), "image/jpeg");
    await outbox("blob.delete", { keys: [key, `${userId}/${scanId}/frames/never-existed.jpg`] });
    await eventually(
      () => blobs.head(key),
      (head) => head === null,
    );
    const { rows } = await eventually(
      () => admin.query("SELECT dispatched_at FROM outbox WHERE payload::text LIKE '%doomed%'"),
      (r) => r.rows[0]?.dispatched_at != null,
    );
    expect(rows).toHaveLength(1);
  });

  it("deletes a whole prefix and nothing beside it", async () => {
    const inside = [`${userId}/gone-scan/frames/a.jpg`, `${userId}/gone-scan/thumbs/b.jpg`];
    const beside = `${userId}/gone-scan-2/frames/c.jpg`;
    for (const key of [...inside, beside]) await blobs.put(key, bytes(key), "image/jpeg");
    await outbox("blob.delete_prefix", { prefix: `${userId}/gone-scan/` });
    for (const key of inside)
      await eventually(
        () => blobs.head(key),
        (h) => h === null,
      );
    expect(await blobs.head(beside)).not.toBeNull();
  });
});

describe("media", () => {
  it("strips EXIF in place and writes a small thumbnail", async () => {
    const key = `${userId}/${scanId}/frames/exif.jpg`;
    const photoId = await addPhoto(key, jpegWithExif(800, 600));
    await outbox("media.process", { photoId });

    const row = await eventually(
      async () =>
        (
          await admin.query(
            "SELECT thumbnail_path, media_checked_at FROM scan_photos WHERE id = $1",
            [photoId],
          )
        ).rows[0],
      (r) => r?.media_checked_at != null,
    );
    expect(row.thumbnail_path).toBe(`${userId}/${scanId}/thumbs/${photoId}.jpg`);

    const original = Buffer.from(await blobs.get(key));
    expect(original.includes("GPS-SECRET-LOCATION")).toBe(false);
    expect([original[0], original[1]]).toEqual([0xff, 0xd8]);

    const thumb = jpeg.decode(await blobs.get(row.thumbnail_path));
    expect(Math.max(thumb.width, thumb.height)).toBe(THUMBNAIL_EDGE_PX);
    expect(thumb.width / thumb.height).toBeCloseTo(800 / 600, 1);
  });

  it("removes an upload that only claims to be an image", async () => {
    const key = `${userId}/${scanId}/frames/fake.jpg`;
    const photoId = await addPhoto(key, bytes("<html>not an image, honest</html>"));
    await outbox("media.process", { photoId });

    await eventually(
      async () =>
        (await admin.query("SELECT 1 FROM scan_photos WHERE id = $1", [photoId])).rows.length,
      (n) => n === 0,
    );
    await eventually(
      () => blobs.head(key),
      (h) => h === null,
    );
  });

  it("is a no-op for a frame that was deleted before its job ran", async () => {
    await outbox("media.process", { photoId: "00000000-0000-4000-8000-000000000000" });
    await eventually(
      () =>
        admin.query(
          "SELECT dispatched_at FROM outbox WHERE payload->>'photoId' = '00000000-0000-4000-8000-000000000000'",
        ),
      (r) => r.rows[0]?.dispatched_at != null,
    );
  });
});

describe("maintenance", () => {
  it("sweeps upload sessions nobody completed and queues their blobs for deletion", async () => {
    const key = `${userId}/${scanId}/frames/abandoned.jpg`;
    await blobs.put(key, bytes("x"), "image/jpeg");
    const files = [{ index: 0, kind: "frame", key, contentType: "image/jpeg", maxBytes: 1 }];
    await admin.query(
      `INSERT INTO upload_sessions (user_id, scan_id, files, expires_at)
       VALUES ($1, $2, $3, now() - interval '2 hours'), ($1, $2, '[]', now() + interval '10 minutes')`,
      [userId, scanId, JSON.stringify(files)],
    );
    const { sessions } = await worker.get(MaintenanceProcessor).sweepUploadSessions();
    expect(sessions).toBe(1);
    const { rows } = await admin.query("SELECT 1 FROM upload_sessions WHERE scan_id = $1", [
      scanId,
    ]);
    expect(rows).toHaveLength(1);
    await eventually(
      () => blobs.head(key),
      (h) => h === null,
    );
  });
});

describe("health", () => {
  it("is live, and ready while Postgres and Redis answer", async () => {
    let draining = false;
    const server = startHealthServer(worker, {
      port: 0,
      redisUrl: config.queue.redisUrl,
      isDraining: () => draining,
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      draining = true;
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
