// Tenant-isolation suite (migration plan §10.3). Replaces the guarantee
// Supabase's row-level security gave: one user can never read or change
// another user's data. It is deliberately generic, so it covers every route
// the app registers, including routes added later.
import type { AuthSession, MeResponse, ScanListResponse } from "@spatial/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScan, issueUpload, putFile, uploadFrames } from "./helpers/spaces";
import { Client, startTestApp, type TestApp, uniqueEmail } from "./helpers/test-app";
import { PUBLIC_ROUTES, SELF_SCOPED_ROUTES, TENANT_SCOPED_ROUTES } from "./route-policy";

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;

async function newUser() {
  const client = new Client(t.app);
  const res = await client.request<AuthSession>({
    method: "POST",
    url: "/v1/auth/sign-up",
    body: { email: uniqueEmail("tenant"), password: "tenant-password-1" },
  });
  expect(res.status).toBe(201);
  return { client, token: res.body.accessToken, id: res.body.user.id };
}

/** A concrete URL for a route pattern, e.g. /v1/scans/:id -> /v1/scans/<uuid>. */
const concrete = (url: string) =>
  url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");

describe("route classification", () => {
  it("classifies every registered route exactly once", () => {
    const registered = [...new Set(t.routes.map(key))].sort();
    const classified = [
      ...PUBLIC_ROUTES,
      ...SELF_SCOPED_ROUTES,
      ...TENANT_SCOPED_ROUTES.map((r) => r.route),
    ];
    const duplicates = classified.filter((r, i) => classified.indexOf(r) !== i);
    expect(duplicates, "routes listed twice in route-policy.ts").toEqual([]);

    const unclassified = registered.filter((r) => !classified.includes(r as never));
    expect(unclassified, "add these routes to test/route-policy.ts").toEqual([]);
    const stale = classified.filter((r) => !registered.includes(r));
    expect(stale, "route-policy.ts lists routes the app no longer has").toEqual([]);
  });
});

describe("authentication", () => {
  it("refuses every non-public route without a token, or with a forged one", async () => {
    const publicRoutes = new Set<string>(PUBLIC_ROUTES);
    const protectedRoutes = t.routes.filter((r) => !publicRoutes.has(key(r)));
    expect(protectedRoutes.length).toBeGreaterThan(0);

    const forged =
      "eyJhbGciOiJFZERTQSIsImtpZCI6ImZha2UifQ.eyJzdWIiOiJ4Iiwic2lkIjoieSJ9.c2lnbmF0dXJl";
    const client = new Client(t.app);
    for (const route of protectedRoutes) {
      for (const token of [undefined, forged]) {
        const res = await client.request({
          method: route.method as "GET",
          url: concrete(route.url),
          ...(token ? { token } : {}),
        });
        expect(res.status, `${key(route)} with ${token ? "a forged" : "no"} token`).toBe(401);
      }
    }
  });
});

describe("self-scoped routes", () => {
  it("only ever return the caller's own account", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    const asAlice = await alice.client.request<MeResponse>({
      method: "GET",
      url: "/v1/me",
      token: alice.token,
    });
    const asBob = await bob.client.request<MeResponse>({
      method: "GET",
      url: "/v1/me",
      token: bob.token,
    });
    expect(asAlice.body.user.id).toBe(alice.id);
    expect(asBob.body.user.id).toBe(bob.id);
  });

  it("never list another user's spaces", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await createScan(alice, { name: "Alice's room" });
    const asBob = await bob.client.request<ScanListResponse>({
      method: "GET",
      url: "/v1/scans?q=Alice",
      token: bob.token,
    });
    expect(asBob.body.items).toEqual([]);
    expect(asBob.body.totals.count).toBe(0);
  });
});

describe("cross-wired ids", () => {
  // Owning the scan in the path must not unlock someone else's child resource.
  it("won't complete another user's upload session through the caller's own scan", async () => {
    const [owner, stranger] = await Promise.all([newUser(), newUser()]);
    const ownerScan = await createScan(owner);
    const issued = await issueUpload(owner, ownerScan.id, [
      { kind: "frame", contentType: "image/jpeg", sizeBytes: 12 },
    ]);
    await putFile(issued.body.files[0]!);
    const strangerScan = await createScan(stranger);
    const res = await stranger.client.request({
      method: "POST",
      url: `/v1/scans/${strangerScan.id}/uploads/${issued.body.sessionId}/complete`,
      token: stranger.token,
      body: { frames: [{ fileIndex: 0, headingDeg: 0 }] },
    });
    expect(res.status).toBe(404);
  });

  it("won't delete another user's frame through the caller's own scan", async () => {
    const [owner, stranger] = await Promise.all([newUser(), newUser()]);
    const ownerScan = await createScan(owner);
    const { complete } = await uploadFrames(owner, ownerScan.id, [{}]);
    const strangerScan = await createScan(stranger);
    const res = await stranger.client.request({
      method: "DELETE",
      url: `/v1/scans/${strangerScan.id}/photos/${complete.body.photos[0]!.id}`,
      token: stranger.token,
    });
    expect(res.status).toBe(404);
    const detail = await owner.client.request<{ photos: unknown[] }>({
      method: "GET",
      url: `/v1/scans/${ownerScan.id}`,
      token: owner.token,
    });
    expect(detail.body.photos).toHaveLength(1);
  });
});

describe("tenant-scoped routes", () => {
  it.each(TENANT_SCOPED_ROUTES.map((r) => [r.route, r] as const))(
    "%s: another user gets 404, the owner succeeds",
    async (_name, route) => {
      const [owner, stranger] = await Promise.all([newUser(), newUser()]);
      const { url, body } = await route.setup(owner);
      const method = route.route.split(" ")[0] as "GET";

      const asStranger = await stranger.client.request({
        method,
        url,
        body,
        token: stranger.token,
      });
      expect(asStranger.status).toBe(404);
      const asOwner = await owner.client.request({ method, url, body, token: owner.token });
      expect(asOwner.status).toBe(route.ownerStatus);
    },
  );
});
