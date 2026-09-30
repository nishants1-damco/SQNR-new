import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, startTestApp, type TestApp } from "./helpers/test-app";

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe("health", () => {
  it("is live without touching dependencies", async () => {
    const res = await new Client(t.app).request({ method: "GET", url: "/health/live" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is ready when Postgres and Redis answer", async () => {
    const res = await new Client(t.app).request<{
      status: string;
      checks: Record<string, { ok: boolean }>;
    }>({ method: "GET", url: "/health/ready" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks["database"]?.ok).toBe(true);
    expect(res.body.checks["redis"]?.ok).toBe(true);
  });
});
