// Phase 5 limits end to end: the Redis limiter, the global request throttle,
// the Postgres quota backend, daily AI spend caps and queue backpressure.
import type { ErrorEnvelope, StartAnalysisResponse } from "@spatial/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalysisLimits } from "../src/analysis/analysis-limits";
import { RateLimiter } from "../src/common/rate-limiter";
import { createScan, issueUpload, signUp, uploadFrames, type User } from "./helpers/spaces";
import { startTestApp, type TestApp } from "./helpers/test-app";

let t: TestApp;
let admin: pg.Client;

beforeAll(async () => {
  t = await startTestApp({
    THROTTLE_USER_PER_MINUTE: "20",
    AI_DAILY_BUDGET_USD_PER_USER: "6",
    ANALYSIS_COST_ESTIMATE_USD: "5",
  });
  admin = new pg.Client({ connectionString: t.database.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await t?.close();
});

const start = (user: User, scanId: string) =>
  user.client.request<StartAnalysisResponse & ErrorEnvelope>({
    method: "POST",
    url: `/v1/scans/${scanId}/analysis`,
    token: user.token,
    body: {},
  });

describe("RateLimiter (GCRA in Redis)", () => {
  it("allows max requests per window, then says how long to wait", async () => {
    const limiter = t.app.get(RateLimiter);
    const key = `test:${Date.now()}`;
    const limit = { max: 3, windowMs: 60_000 };
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.hit(key, limit));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    // One request's worth of the window (20 s) until the next is allowed.
    expect(decisions[3]!.retryAfterMs).toBeGreaterThan(19_000);
    expect(decisions[3]!.retryAfterMs).toBeLessThanOrEqual(20_000);
  });
});

describe("request throttle", () => {
  it("caps requests per signed-in user and names the retry time", async () => {
    const user = await signUp(t, "throttle");
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await user.client.request({ method: "GET", url: "/v1/me", token: user.token });
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("never throttles health probes", async () => {
    for (let i = 0; i < 70; i++) {
      const res = await t.app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("daily AI spend cap", () => {
  it("refuses a run that would take the user past the day's budget", async () => {
    const user = await signUp(t, "budget");
    const first = await createScan(user);
    await uploadFrames(user, first.id, [{}]);
    const second = await createScan(user);
    await uploadFrames(user, second.id, [{}]);

    // $6 a day, $5 per run: the first fits, the second (with the first still live) doesn't.
    expect((await start(user, first.id)).status).toBe(202);
    const refused = await start(user, second.id);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toMatch(/budget/);

    // Finished runs count at their recorded cost.
    await admin.query(
      `UPDATE scan_analyses SET status = 'succeeded', cost_estimate_usd = 0.4 WHERE user_id = $1`,
      [user.id],
    );
    expect((await start(user, second.id)).status).toBe(202);
  });
});

describe("with the Postgres quota backend and a queue limit", () => {
  let t2: TestApp;
  beforeAll(async () => {
    t2 = await startTestApp({ QUOTA_BACKEND: "postgres", ANALYSIS_MAX_QUEUED: "1" });
  });
  afterAll(async () => {
    await t2?.close();
  });

  it("counts quotas in consume_rate_limit, as before phase 5", async () => {
    const user = await signUp(t2, "pg-quota");
    const scan = await createScan(user);
    const db = new pg.Client({ connectionString: t2.database.adminUrl });
    await db.connect();
    await db.query(
      `INSERT INTO user_rate_limits (user_id, bucket, window_started_at, count)
       VALUES ($1, 'upload_session', now(), 120)`,
      [user.id],
    );
    await db.end();
    const res = await issueUpload(user, scan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    expect(res.status).toBe(429);
  });

  it("answers 503 with Retry-After while the queue is full", async () => {
    const a = await signUp(t2, "queue-a");
    const b = await signUp(t2, "queue-b");
    const scanA = await createScan(a);
    await uploadFrames(a, scanA.id, [{}]);
    const scanB = await createScan(b);
    await uploadFrames(b, scanB.id, [{}]);

    expect((await start(a, scanA.id)).status).toBe(202);
    t2.app.get(AnalysisLimits).reset();
    const refused = await start(b, scanB.id);
    expect(refused.status).toBe(503);
    expect(Number(refused.headers["retry-after"])).toBe(120);
  });
});
