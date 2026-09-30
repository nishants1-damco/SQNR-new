// Tenant-isolation suite (migration plan §10.3). Replaces the guarantee
// Supabase's row-level security gave: one user can never read or change
// another user's data. It is deliberately generic, so it covers every route
// the app registers, including routes added later.
import type { AuthSession, MeResponse } from "@spatial/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});

describe("tenant-scoped routes", () => {
  if (TENANT_SCOPED_ROUTES.length === 0) {
    it.todo("no resource routes yet: phase 2 adds scans, uploads and exports");
    return;
  }

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
