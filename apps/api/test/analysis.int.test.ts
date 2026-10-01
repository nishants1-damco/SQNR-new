// Phase 3 endpoints end to end: queueing an analysis (the idempotency and
// status gate, the claim, quotas), its status, the event stream, and the
// privacy sweep. The worker side is covered in apps/worker's tests.
import type {
  AnalysisStatusResponse,
  ErrorEnvelope,
  PrivacyPurgeResponse,
  StartAnalysisResponse,
} from "@spatial/contracts";
import { analysisEventsChannel } from "@spatial/contracts";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScan, signUp, uploadFrames, type User } from "./helpers/spaces";
import { REDIS } from "../src/redis/redis.module";
import { startTestApp, type TestApp } from "./helpers/test-app";

let t: TestApp;
let admin: pg.Client;
let publisher: Redis;

beforeAll(async () => {
  t = await startTestApp();
  admin = new pg.Client({ connectionString: t.database.adminUrl });
  await admin.connect();
  publisher = new Redis(t.config.queue.redisUrl);
});

afterAll(async () => {
  await publisher?.quit();
  await admin?.end();
  await t?.close();
});

const start = (user: User, scanId: string, body: Record<string, unknown> = {}) =>
  user.client.request<StartAnalysisResponse & ErrorEnvelope>({
    method: "POST",
    url: `/v1/scans/${scanId}/analysis`,
    token: user.token,
    body,
  });

const status = (user: User, scanId: string) =>
  user.client.request<AnalysisStatusResponse & ErrorEnvelope>({
    method: "GET",
    url: `/v1/scans/${scanId}/analysis`,
    token: user.token,
  });

async function scanWithFrames(user: User, body: Record<string, unknown> = {}) {
  const scan = await createScan(user, body);
  await uploadFrames(user, scan.id, [{}, {}]);
  return scan;
}

const outbox = async (topic: string, scanId: string) =>
  (
    await admin.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox WHERE topic = $1 AND payload->>'scanId' = $2 ORDER BY id",
      [topic, scanId],
    )
  ).rows.map((r) => r.payload);

describe("POST /v1/scans/:id/analysis", () => {
  it("claims the scan, records the run and queues the job in one go", async () => {
    const user = await signUp(t, "analysis");
    const scan = await scanWithFrames(user);
    const res = await start(user, scan.id);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      outcome: "queued",
      scanId: scan.id,
      provider: "claude",
      model: "claude-opus-5-5",
    });
    const analysisId = res.body.analysisId!;

    expect(await outbox("analysis.cloud", scan.id)).toEqual([
      {
        analysisId,
        scanId: scan.id,
        userId: user.id,
        provider: "claude",
        model: "claude-opus-5-5",
      },
    ]);
    const { rows } = await admin.query(
      `SELECT s.status, s.provider, s.prompt_version, s.analysis_notes AS notes, a.status AS run
       FROM scans s JOIN scan_analyses a ON a.scan_id = s.id WHERE s.id = $1`,
      [scan.id],
    );
    expect(rows[0]).toMatchObject({
      status: "processing",
      provider: "claude",
      prompt_version: "recon-v6",
      run: "queued",
      notes: { analysis_id: analysisId, stage: "queued" },
    });
    expect(Date.parse(rows[0].notes.deadline_at) - Date.parse(rows[0].notes.started_at)).toBe(
      30 * 60 * 1000,
    );

    const st = await status(user, scan.id);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({
      scanStatus: "processing",
      stage: "queued",
      progressPct: 0,
      error: null,
      run: { id: analysisId, status: "queued", model: "claude-opus-5-5", attempts: 0 },
    });
    expect(st.body.deadlineAt).toBe(rows[0].notes.deadline_at);
  });

  it("leaves a run in progress alone, and re-runs one past its deadline", async () => {
    const user = await signUp(t, "analysis");
    const scan = await scanWithFrames(user);
    const first = await start(user, scan.id);
    const again = await start(user, scan.id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      outcome: "already_running",
      analysisId: first.body.analysisId,
      provider: "claude",
    });
    expect(await outbox("analysis.cloud", scan.id)).toHaveLength(1);

    // The worker died and nobody swept it yet: the deadline has passed.
    await admin.query(
      `UPDATE scans SET analysis_notes = analysis_notes || jsonb_build_object('deadline_at', now() - interval '1 minute') WHERE id = $1`,
      [scan.id],
    );
    const rerun = await start(user, scan.id);
    expect(rerun.status).toBe(202);
    expect(rerun.body.analysisId).not.toBe(first.body.analysisId);
    const runs = await admin.query(
      "SELECT id, status FROM scan_analyses WHERE scan_id = $1 ORDER BY created_at",
      [scan.id],
    );
    expect(runs.rows.map((r) => r.status)).toEqual(["timed_out", "queued"]);
  });

  it("points a repeated capture at the space it already created", async () => {
    const user = await signUp(t, "analysis");
    const captureId = crypto.randomUUID();
    const original = await scanWithFrames(user, { captureId });
    const other = await scanWithFrames(user);
    const res = await start(user, other.id, { captureId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "duplicate", scanId: original.id, analysisId: null });
    expect(await outbox("analysis.cloud", other.id)).toHaveLength(0);
  });

  it("refuses a space with no frames, without charging the quota", async () => {
    const user = await signUp(t, "analysis");
    const scan = await createScan(user);
    const res = await start(user, scan.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
    const redis = t.app.get<Redis>(REDIS);
    expect(await redis.exists(`ratelimit:quota:analyze_scan:${user.id}`)).toBe(0);
  });

  it("queues local-model runs on their own queue", async () => {
    const user = await signUp(t, "analysis");
    const scan = await scanWithFrames(user);
    const res = await start(user, scan.id, { provider: "ollama" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ provider: "ollama", model: "qwen2.5vl-3b-48k" });
    expect(await outbox("analysis.local", scan.id)).toHaveLength(1);
    const deadline = await admin.query(
      `SELECT (analysis_notes->>'deadline_at')::timestamptz - (analysis_notes->>'started_at')::timestamptz AS span FROM scans WHERE id = $1`,
      [scan.id],
    );
    expect(deadline.rows[0].span).toMatchObject({ hours: 3 });
  });

  it("allows 5 analyses an hour per user", async () => {
    const user = await signUp(t, "analysis");
    const scan = await scanWithFrames(user);
    for (let i = 0; i < 5; i++) {
      expect((await start(user, scan.id)).status).toBe(202);
      await admin.query("UPDATE scans SET status = 'ready' WHERE id = $1", [scan.id]);
    }
    const limited = await start(user, scan.id);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("GET /v1/scans/:id/analysis/events", () => {
  const stream = (user: User, scanId: string) =>
    t.app.inject({
      method: "GET",
      url: `/v1/scans/${scanId}/analysis/events`,
      headers: { authorization: `Bearer ${user.token}`, origin: "http://localhost:5173" },
    });

  const events = (body: string) =>
    body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event:"))
      .map((chunk) => {
        const [eventLine, dataLine] = chunk.split("\n");
        return {
          event: eventLine!.slice("event: ".length),
          data: JSON.parse(dataLine!.slice("data: ".length)) as Record<string, unknown>,
        };
      });

  it("sends a snapshot and ends at once for a scan that isn't processing", async () => {
    const user = await signUp(t, "events");
    const scan = await createScan(user);
    const res = await stream(user, scan.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(events(res.body)).toEqual([
      { event: "status", data: expect.objectContaining({ scanStatus: "draft", run: null }) },
    ]);
  });

  it("relays the worker's progress until the run is done", async () => {
    const user = await signUp(t, "events");
    const scan = await scanWithFrames(user);
    const { body } = await start(user, scan.id);
    const channel = analysisEventsChannel(t.config.queue.prefix, scan.id);
    const pending = stream(user, scan.id);
    // Publish once the stream has subscribed.
    for (let i = 0; i < 50; i++) {
      const [, count] = (await publisher.pubsub("NUMSUB", channel)) as [string, number];
      if (Number(count) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const event = (stage: string, pct: number) =>
      JSON.stringify({ scanId: scan.id, analysisId: body.analysisId, stage, pct, message: stage });
    await publisher.publish(channel, event("pass1", 55));
    await publisher.publish(channel, event("done", 100));
    const res = await pending;
    expect(events(res.body).map((e) => [e.event, e.data["stage"]])).toEqual([
      ["status", "queued"],
      ["progress", "pass1"],
      ["progress", "done"],
    ]);
  });
});

describe("POST /v1/scans/:id/privacy-purge", () => {
  it("queues one sweep and doesn't queue another while it's pending", async () => {
    const user = await signUp(t, "privacy");
    const scan = await scanWithFrames(user);
    const purge = () =>
      user.client.request<PrivacyPurgeResponse>({
        method: "POST",
        url: `/v1/scans/${scan.id}/privacy-purge`,
        token: user.token,
      });
    const first = await purge();
    expect(first.status).toBe(202);
    const second = await purge();
    expect(second.body.requestedAt).toBe(first.body.requestedAt);
    expect(await outbox("privacy.purge", scan.id)).toEqual([
      { scanId: scan.id, userId: user.id, requestedAt: first.body.requestedAt },
    ]);
  });
});
