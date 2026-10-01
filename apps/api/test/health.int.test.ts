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

describe("behind Front Door", () => {
  const frontDoorId = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
  let edge: TestApp;

  beforeAll(async () => {
    edge = await startTestApp({ FRONT_DOOR_ID: frontDoorId, TRUST_PROXY: "2" });
  });

  afterAll(async () => {
    await edge?.close();
  });

  it("refuses requests that didn't come through our profile", async () => {
    const client = new Client(edge.app);
    for (const headers of [{}, { "x-azure-fdid": "00000000-0000-4000-8000-000000000000" }]) {
      const res = await client.request({ method: "GET", url: "/v1/me", headers });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "unauthorized" });
    }
    const via = await client.request({
      method: "GET",
      url: "/v1/me",
      headers: { "x-azure-fdid": frontDoorId },
    });
    expect(via.status).toBe(401);
  });

  it("still answers the platform's health probes directly", async () => {
    const res = await new Client(edge.app).request({ method: "GET", url: "/health/live" });
    expect(res.status).toBe(200);
  });
});
