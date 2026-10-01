// Read-replica routing (plan §8.4). The "replica" here is a second, empty
// database, so where a read went is visible in its result: the primary knows
// the space, the replica doesn't.
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDIS } from "../src/redis/redis.module";
import { createScan, signUp } from "./helpers/spaces";
import { startTestApp, type TestApp } from "./helpers/test-app";

let t: TestApp;
let replica: TestDatabase;

beforeAll(async () => {
  replica = await createTestDatabase();
  t = await startTestApp({ DATABASE_REPLICA_URL: replica.appUrl, REPLICA_STICKY_SECONDS: "30" });
});

afterAll(async () => {
  await t?.close();
  await replica?.drop();
});

describe("read-replica routing", () => {
  it("reads a user's own fresh writes from the primary, and other reads from the replica", async () => {
    const user = await signUp(t, "replica");
    const scan = await createScan(user);
    const get = (url: string) => user.client.request({ method: "GET", url, token: user.token });

    // Just wrote: detail, list and export read the primary.
    expect((await get(`/v1/scans/${scan.id}`)).status).toBe(200);
    expect((await get("/v1/scans")).body).toMatchObject({ totals: { count: 1 } });
    expect((await get(`/v1/scans/${scan.id}/export?format=geojson`)).status).toBe(200);

    // Once the read-your-writes window has passed, reads go to the replica,
    // which (in this test) has never heard of the space.
    await t.app.get<Redis>(REDIS).del(`rw:${user.id}`);
    expect((await get(`/v1/scans/${scan.id}`)).status).toBe(404);
    expect((await get("/v1/scans")).body).toMatchObject({ totals: { count: 0 } });

    // Writes always go to the primary, and put the user back on it.
    const renamed = await user.client.request({
      method: "PATCH",
      url: `/v1/scans/${scan.id}`,
      token: user.token,
      body: { name: "Renamed" },
    });
    expect(renamed.status).toBe(200);
    expect((await get(`/v1/scans/${scan.id}`)).body).toMatchObject({ scan: { name: "Renamed" } });
  });
});
