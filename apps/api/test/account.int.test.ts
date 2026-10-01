// DELETE /v1/me: erasing an account and everything in it.
import type { AuthSession, ErrorEnvelope } from "@spatial/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScan, uploadFrames } from "./helpers/spaces";
import { Client, startTestApp, type TestApp, uniqueEmail, WEB_ORIGIN } from "./helpers/test-app";

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

const PASSWORD = "account-tests-password";

async function signUp() {
  const client = new Client(t.app);
  const email = uniqueEmail("account");
  const res = await client.request<AuthSession>({
    method: "POST",
    url: "/v1/auth/sign-up",
    body: { email, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  return { client, email, token: res.body.accessToken, id: res.body.user.id };
}

const count = async (sql: string, id: string) =>
  Number((await admin.query<{ n: string }>(sql, [id])).rows[0]?.n);

describe("DELETE /v1/me", () => {
  it("needs the password again, and leaves the account alone without it", async () => {
    const user = await signUp();
    const wrong = await user.client.request<ErrorEnvelope>({
      method: "DELETE",
      url: "/v1/me",
      token: user.token,
      body: { password: "not-the-password" },
    });
    // 403, so clients don't take it for an expired session.
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("invalid_credentials");
    const missing = await user.client.request({
      method: "DELETE",
      url: "/v1/me",
      token: user.token,
      body: {},
    });
    expect(missing.status).toBe(400);
    expect(await count("SELECT count(*) AS n FROM users WHERE id = $1", user.id)).toBe(1);
  });

  it("erases the account, its spaces and sessions, and queues its whole folder", async () => {
    const user = await signUp();
    const scan = await createScan(user);
    await uploadFrames(user, scan.id, [{}, {}]);
    await user.client.request({
      method: "POST",
      url: "/v1/consents",
      token: user.token,
      body: { captureId: crypto.randomUUID(), consentVersion: "2026-09" },
    });

    const res = await user.client.request({
      method: "DELETE",
      url: "/v1/me",
      token: user.token,
      body: { password: PASSWORD },
    });
    expect(res.status).toBe(204);

    for (const table of [
      "users",
      "profiles",
      "scans",
      "scan_photos",
      "auth_refresh_tokens",
      "capture_consents",
    ]) {
      const column = table === "users" || table === "profiles" ? "id" : "user_id";
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, user.id),
        table,
      ).toBe(0);
    }
    const { rows } = await admin.query(
      "SELECT 1 FROM outbox WHERE topic = 'blob.delete_prefix' AND payload->>'prefix' = $1",
      [`${user.id}/`],
    );
    expect(rows).toHaveLength(1);

    // The access token issued before deletion stops working at once...
    const me = await user.client.request<ErrorEnvelope>({
      method: "GET",
      url: "/v1/me",
      token: user.token,
    });
    expect(me.status).toBe(401);
    expect(me.body.message).toBe("This account no longer exists");
    // ...and so does the refresh cookie.
    const refresh = await user.client.request({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { origin: WEB_ORIGIN },
    });
    expect(refresh.status).toBe(401);

    // The email address is free again.
    const again = await new Client(t.app).request({
      method: "POST",
      url: "/v1/auth/sign-up",
      body: { email: user.email, password: PASSWORD },
    });
    expect(again.status).toBe(201);
  });
});
