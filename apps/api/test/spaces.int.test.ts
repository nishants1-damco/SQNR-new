// Phase 2 endpoints end to end: scans, uploads straight to Azurite, frames,
// exports, geocoding, consent and flags.
import type {
  CompleteUploadResponse,
  ErrorEnvelope,
  PhotoUrlsResponse,
  ScanDetailResponse,
  ScanListResponse,
  ScanResponse,
} from "@spatial/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createScan,
  issueUpload,
  JPEG_BYTES,
  putFile,
  signUp,
  uploadFrames,
  type User,
} from "./helpers/spaces";
import { startTestApp, type TestApp } from "./helpers/test-app";

let t: TestApp;
let admin: pg.Client;

beforeAll(async () => {
  t = await startTestApp();
  admin = new pg.Client({ connectionString: t.database.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await t?.close();
});

const get = <T>(user: User, url: string) =>
  user.client.request<T & ErrorEnvelope>({ method: "GET", url, token: user.token });

const outboxFor = async (topic: string, contains: string) =>
  (
    await admin.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox WHERE topic = $1 AND payload::text LIKE $2",
      [topic, `%${contains}%`],
    )
  ).rows.map((r) => r.payload);

describe("scans", () => {
  it("creates a draft space with capture data, idempotently per capture id", async () => {
    const user = await signUp(t);
    const captureId = "5e0c1c70-6a52-4c1b-9d8e-1f2a3b4c5d6e";
    const body = {
      captureId,
      name: "Living room",
      acoustics: { rt60_s: 0.42 },
      analysisNotes: { capture_mode: "auto", stations: 3 },
      siteLocation: { lat: 28.6139, lon: 77.209 },
      scaleReference: "acoustic-ranging",
    };
    const first = await user.client.request<ScanResponse>({
      method: "POST",
      url: "/v1/scans",
      token: user.token,
      body,
    });
    expect(first.status).toBe(201);
    expect(first.body.scan).toMatchObject({
      name: "Living room",
      status: "draft",
      capture_id: captureId,
      acoustics: { rt60_s: 0.42 },
      analysis_notes: { capture_mode: "auto", stations: 3 },
      scale_reference: "acoustic-ranging",
      site_location: { type: "Point", coordinates: [77.209, 28.6139] },
    });

    const again = await user.client.request<ScanResponse>({
      method: "POST",
      url: "/v1/scans",
      token: user.token,
      body,
    });
    expect(again.status).toBe(200);
    expect(again.body.scan.id).toBe(first.body.scan.id);
  });

  it("lists with search, status filter, sort, keyset pages and totals", async () => {
    const user = await signUp(t);
    for (const [name, area] of [
      ["Kitchen", 12],
      ["Bedroom", 20],
      ["Study", 8],
    ] as const) {
      const scan = await createScan(user, { name });
      await admin.query("UPDATE scans SET floor_area_m2 = $1 WHERE id = $2", [area, scan.id]);
    }
    await admin.query("UPDATE scans SET status = 'ready' WHERE name = 'Kitchen' AND user_id = $1", [
      user.id,
    ]);

    const page1 = await get<ScanListResponse>(user, "/v1/scans?sort=area&limit=2");
    expect(page1.body.items.map((i) => i.name)).toEqual(["Bedroom", "Kitchen"]);
    expect(page1.body.totals).toEqual({ count: 3, floorAreaM2: 40 });
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await get<ScanListResponse>(
      user,
      `/v1/scans?sort=area&limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((i) => i.name)).toEqual(["Study"]);
    expect(page2.body.nextCursor).toBeNull();

    expect(
      (await get<ScanListResponse>(user, "/v1/scans?sort=name")).body.items.map((i) => i.name),
    ).toEqual(["Bedroom", "Kitchen", "Study"]);
    expect(
      (await get<ScanListResponse>(user, "/v1/scans?q=itch")).body.items.map((i) => i.name),
    ).toEqual(["Kitchen"]);
    expect((await get<ScanListResponse>(user, "/v1/scans?status=ready")).body.items).toHaveLength(
      1,
    );
    // A cursor from one sort order can't be replayed on another.
    const wrong = await get(user, `/v1/scans?sort=name&cursor=${page1.body.nextCursor}`);
    expect(wrong.status).toBe(400);
  });

  it("pages through spaces created in the same millisecond without skipping any", async () => {
    const user = await signUp(t);
    const scan = await createScan(user, { name: "A" });
    for (const name of ["B", "C", "D"]) {
      await admin.query(
        "INSERT INTO scans (user_id, name, created_at) SELECT user_id, $1, created_at FROM scans WHERE id = $2",
        [name, scan.id],
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: ScanListResponse } = await get<ScanListResponse>(
        user,
        `/v1/scans?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...res.body.items.map((i) => i.name));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("merges capture-owned analysis notes and keeps server-written ones", async () => {
    const user = await signUp(t);
    const scan = await createScan(user, { analysisNotes: { stations: 2 } });
    await admin.query(
      `UPDATE scans SET analysis_notes = analysis_notes || '{"error":"old run"}' WHERE id = $1`,
      [scan.id],
    );

    const res = await user.client.request<ScanResponse>({
      method: "PATCH",
      url: `/v1/scans/${scan.id}`,
      token: user.token,
      body: { name: "Renamed", analysisNotes: { wall_ranges: [{ distance_m: 2 }] } },
    });
    expect(res.status).toBe(200);
    expect(res.body.scan.name).toBe("Renamed");
    expect(res.body.scan.analysis_notes).toEqual({
      stations: 2,
      error: "old run",
      wall_ranges: [{ distance_m: 2 }],
    });
    const forbidden = await user.client.request<ErrorEnvelope>({
      method: "PATCH",
      url: `/v1/scans/${scan.id}`,
      token: user.token,
      body: { analysisNotes: { deadline_at: "2099-01-01" } },
    });
    expect(forbidden.status).toBe(400);
  });
});

describe("uploads", () => {
  it("records frames uploaded straight to storage and serves them back", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    const { complete } = await uploadFrames(user, scan.id, [{ station: 0 }, { station: 0 }], {
      depth: true,
    });
    expect(complete.status).toBe(200);
    expect(complete.body.photos.map((p) => p.idx)).toEqual([0, 1]);
    expect(complete.body.depth_path).toMatch(
      new RegExp(`^${user.id}/${scan.id}/depth/[0-9a-f]{8}-room_scan\\.ply$`),
    );

    const detail = await get<ScanDetailResponse>(user, `/v1/scans/${scan.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.photos).toHaveLength(2);
    expect(detail.body.scan["depth_path"]).toBe(complete.body.depth_path);
    const frame = await fetch(detail.body.photos[0]!.url!);
    expect(frame.status).toBe(200);
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(JPEG_BYTES);

    // Each new frame is queued for the media check.
    for (const photo of complete.body.photos) {
      expect(await outboxFor("media.process", photo.id)).toHaveLength(1);
    }
  });

  it("numbers frames after the existing ones", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    await uploadFrames(user, scan.id, [{}, {}]);
    const { complete } = await uploadFrames(user, scan.id, [{}]);
    expect(complete.body.photos.map((p) => p.idx)).toEqual([2]);
  });

  it("refuses to complete with files that weren't uploaded, or twice", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    const issued = await issueUpload(user, scan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    await putFile(issued.body.files[0]!);
    const complete = (fileIndexes: number[]) =>
      user.client.request<CompleteUploadResponse & ErrorEnvelope>({
        method: "POST",
        url: `/v1/scans/${scan.id}/uploads/${issued.body.sessionId}/complete`,
        token: user.token,
        body: { frames: fileIndexes.map((fileIndex) => ({ fileIndex, headingDeg: 0 })) },
      });

    const missing = await complete([0, 1]);
    expect(missing.status).toBe(400);
    expect(missing.body.details).toEqual([
      expect.objectContaining({ index: 1, problem: "not uploaded" }),
    ]);

    expect((await complete([0])).status).toBe(200);
    const twice = await complete([0]);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("conflict");
    // The signed-but-unused file is queued for deletion.
    expect(await outboxFor("blob.delete", issued.body.files[1]!.key)).toHaveLength(1);
  });

  it("rejects a blob stored with the wrong content type", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    const issued = await issueUpload(user, scan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    expect(await putFile(issued.body.files[0]!, JPEG_BYTES, { "content-type": "text/html" })).toBe(
      201,
    );
    const res = await user.client.request<ErrorEnvelope>({
      method: "POST",
      url: `/v1/scans/${scan.id}/uploads/${issued.body.sessionId}/complete`,
      token: user.token,
      body: { frames: [{ fileIndex: 0, headingDeg: 0 }] },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain("text/html");
  });

  it("replaces a reshot viewpoint's frames and leaves the others", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    await uploadFrames(user, scan.id, [{ station: 0 }, { station: 1 }, { station: 1 }]);
    const { complete } = await uploadFrames(user, scan.id, [{ station: 1 }], {
      replaceStations: [1],
    });
    expect(complete.body.replaced).toBe(2);

    const detail = await get<ScanDetailResponse>(user, `/v1/scans/${scan.id}`);
    const stations = detail.body.photos.map(
      (p) => (p["sensor_payload"] as { station: number }).station,
    );
    expect(stations.sort()).toEqual([0, 1]);
  });

  it("won't take uploads while the space is being reconstructed", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    await admin.query(
      `UPDATE scans SET status = 'processing',
         analysis_notes = jsonb_build_object('deadline_at', (now() + interval '20 minutes')::text)
       WHERE id = $1`,
      [scan.id],
    );
    const res = await issueUpload(user, scan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    expect(res.status).toBe(409);
  });
});

describe("quotas", () => {
  it("rate-limits upload sessions per user and says when to retry", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    // As if the user had already opened this hour's allowance of sessions.
    await admin.query(
      `INSERT INTO user_rate_limits (user_id, bucket, window_started_at, count)
       VALUES ($1, 'upload_session', now(), 120)`,
      [user.id],
    );
    const res = await issueUpload(user, scan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("frames and deletion", () => {
  it("removes one frame, records why, and queues its blob for deletion", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    const { complete } = await uploadFrames(user, scan.id, [{ station: 0 }, { station: 0 }]);
    const doomed = complete.body.photos[0]!;

    const res = await user.client.request({
      method: "DELETE",
      url: `/v1/scans/${scan.id}/photos/${doomed.id}`,
      token: user.token,
    });
    expect(res.status).toBe(204);
    const detail = await get<ScanDetailResponse>(user, `/v1/scans/${scan.id}`);
    expect(detail.body.photos.map((p) => p.id)).not.toContain(doomed.id);
    expect(detail.body.scan.analysis_notes["frame_removals"]).toEqual([
      expect.objectContaining({
        reason: "manual",
        source: "manual",
        frames: [expect.objectContaining({ idx: 0 })],
      }),
    ]);
    expect(await outboxFor("blob.delete", doomed.storage_path)).toHaveLength(1);
  });

  it("deletes a space with its rows and queues its whole folder, keeping consent", async () => {
    const user = await signUp(t);
    const scan = await createScan(user, { captureId: "0f7c6a5b-4d3e-4a2b-8c1d-0e9f8a7b6c5d" });
    await uploadFrames(user, scan.id, [{}]);
    await user.client.request({
      method: "POST",
      url: "/v1/consents",
      token: user.token,
      body: { captureId: "0f7c6a5b-4d3e-4a2b-8c1d-0e9f8a7b6c5d", consentVersion: "2026-09" },
    });

    expect(
      (
        await user.client.request({
          method: "DELETE",
          url: `/v1/scans/${scan.id}`,
          token: user.token,
        })
      ).status,
    ).toBe(204);
    expect((await get(user, `/v1/scans/${scan.id}`)).status).toBe(404);
    expect(await outboxFor("blob.delete_prefix", `${user.id}/${scan.id}/`)).toHaveLength(1);
    const photos = await admin.query("SELECT 1 FROM scan_photos WHERE scan_id = $1", [scan.id]);
    expect(photos.rows).toHaveLength(0);
    const consents = await admin.query("SELECT 1 FROM capture_consents WHERE user_id = $1", [
      user.id,
    ]);
    expect(consents.rows).toHaveLength(1);
  });
});

describe("read URLs", () => {
  it("signs the caller's own blobs and reports everything else as missing", async () => {
    const owner = await signUp(t);
    const scan = await createScan(owner);
    const { complete } = await uploadFrames(owner, scan.id, [{}]);
    const path = complete.body.photos[0]!.storage_path;

    const own = await owner.client.request<PhotoUrlsResponse>({
      method: "POST",
      url: "/v1/scans/photo-urls",
      token: owner.token,
      body: { paths: [path, "someone/else.jpg"] },
    });
    expect(own.status).toBe(200);
    expect(Object.keys(own.body.urls)).toEqual([path]);
    expect(own.body.missing).toEqual(["someone/else.jpg"]);

    const stranger = await signUp(t);
    const theirs = await stranger.client.request<PhotoUrlsResponse>({
      method: "POST",
      url: "/v1/scans/photo-urls",
      token: stranger.token,
      body: { paths: [path] },
    });
    expect(theirs.body.urls).toEqual({});
    expect(theirs.body.missing).toEqual([path]);
  });
});

describe("export", () => {
  it("returns every format, or just the one asked for", async () => {
    const user = await signUp(t);
    const scan = await createScan(user, { name: "Export room" });
    await admin.query(
      "UPDATE scans SET footprint = ST_GeomFromText('POLYGON((-2 -1.5, 2 -1.5, 2 1.5, -2 1.5, -2 -1.5))', 0), width_m = 4, length_m = 3, height_m = 2.5 WHERE id = $1",
      [scan.id],
    );
    const all = await get<Record<string, Record<string, unknown>>>(
      user,
      `/v1/scans/${scan.id}/export`,
    );
    expect(all.status).toBe(200);
    expect(Object.keys(all.body).sort()).toEqual(["geojson", "imdf", "layers", "postgis", "usd"]);
    expect(all.body["geojson"]!["type"]).toBe("FeatureCollection");
    expect(all.body["layers"]).toMatchObject({ room_name: "Export room", scan_id: scan.id });

    const usd = await get<{ usda: string }>(user, `/v1/scans/${scan.id}/export?format=usd`);
    expect(usd.body.usda).toContain("#usda");
  });
});

describe("geocoding", () => {
  it("stores a precise address for a space and geocodes typed addresses", async () => {
    const user = await signUp(t);
    const scan = await createScan(user);
    const res = await user.client.request<{ address: string }>({
      method: "POST",
      url: `/v1/scans/${scan.id}/address`,
      token: user.token,
      body: { lat: 28.6139, lon: 77.209 },
    });
    expect(res.status).toBe(200);
    expect(res.body.address).toMatch(/^1 Test Street/);
    const list = await get<ScanListResponse>(user, "/v1/scans");
    expect(list.body.items[0]?.site_address).toBe(res.body.address);

    expect(
      (await get<{ result: unknown }>(user, "/v1/geocode?address=Connaught%20Place")).body.result,
    ).toEqual({
      lat: 28.6139,
      lon: 77.209,
    });
    expect(
      (await get<{ result: unknown }>(user, "/v1/geocode?address=nowhere%20at%20all")).body.result,
    ).toBeNull();
  });
});

describe("consent and flags", () => {
  it("records consent once per capture session", async () => {
    const user = await signUp(t);
    const body = { captureId: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", consentVersion: "2026-09" };
    for (let i = 0; i < 2; i++) {
      const res = await user.client.request({
        method: "POST",
        url: "/v1/consents",
        token: user.token,
        body,
      });
      expect(res.status).toBe(201);
    }
    const { rows } = await admin.query("SELECT 1 FROM capture_consents WHERE user_id = $1", [
      user.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("resolves global flags with per-user overrides", async () => {
    const user = await signUp(t);
    await admin.query(
      `INSERT INTO feature_flags (key, user_id, enabled) VALUES
         ('new_viewer', NULL, false), ('new_viewer', $1, true), ('beta_export', NULL, true)`,
      [user.id],
    );
    const res = await get<{ flags: Record<string, boolean> }>(user, "/v1/flags");
    expect(res.body.flags).toEqual({ new_viewer: true, beta_export: true });
    const other = await signUp(t);
    expect((await get<{ flags: Record<string, boolean> }>(other, "/v1/flags")).body.flags).toEqual({
      new_viewer: false,
      beta_export: true,
    });
  });
});
