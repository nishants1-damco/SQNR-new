// End-to-end auth flows through the real HTTP stack (plan §10), against a
// throwaway database, the local Redis and Mailpit.
import type { AuthSession, ErrorEnvelope, MeResponse } from "@spatial/contracts";
import bcrypt from "bcryptjs";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFRESH_COOKIE } from "../src/auth/auth.controller";
import { countEmails, latestEmail, tokenFrom } from "./helpers/mailpit";
import { Client, startTestApp, type TestApp, uniqueEmail, WEB_ORIGIN } from "./helpers/test-app";

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

const PASSWORD = "a-long-enough-password";

async function signUp(client: Client, email = uniqueEmail(), password = PASSWORD) {
  const res = await client.request<AuthSession>({
    method: "POST",
    url: "/v1/auth/sign-up",
    body: { email, password },
  });
  expect(res.status).toBe(201);
  return { email, session: res.body };
}

const signIn = (client: Client, email: string, password: string) =>
  client.request<AuthSession & ErrorEnvelope>({
    method: "POST",
    url: "/v1/auth/sign-in",
    body: { email, password },
  });

const refresh = (client: Client, origin = WEB_ORIGIN) =>
  client.request<AuthSession & ErrorEnvelope>({
    method: "POST",
    url: "/v1/auth/refresh",
    headers: { origin },
  });

const me = (client: Client, token: string) =>
  client.request<MeResponse & ErrorEnvelope>({ method: "GET", url: "/v1/me", token });

describe("sign-up", () => {
  it("creates the account, signs straight in and sets a locked-down refresh cookie", async () => {
    const client = new Client(t.app);
    const email = uniqueEmail("signup");
    const res = await client.request<AuthSession>({
      method: "POST",
      url: "/v1/auth/sign-up",
      body: { email: email.toUpperCase(), password: PASSWORD },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 900,
      user: { email, emailVerified: false, displayName: email },
    });
    expect(res.headers["cache-control"]).toBe("no-store");

    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/v1/auth" });

    const profile = await me(client, res.body.accessToken);
    expect(profile.status).toBe(200);
    expect(profile.body.user.id).toBe(res.body.user.id);
  });

  it("refuses a second account for the same address, whatever the case", async () => {
    const client = new Client(t.app);
    const { email } = await signUp(client);
    const res = await client.request<ErrorEnvelope>({
      method: "POST",
      url: "/v1/auth/sign-up",
      body: { email: email.toUpperCase(), password: PASSWORD },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_taken");
  });

  it("returns field-level validation errors", async () => {
    const res = await new Client(t.app).request<ErrorEnvelope>({
      method: "POST",
      url: "/v1/auth/sign-up",
      body: { email: "not-an-email", password: "123" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect((res.body.details as { path: string }[]).map((d) => d.path).sort()).toEqual([
      "email",
      "password",
    ]);
  });
});

describe("email verification", () => {
  it("verifies through the emailed link, once", async () => {
    const client = new Client(t.app);
    const { email, session } = await signUp(client, uniqueEmail("verify"));
    const mail = await latestEmail(email, /Confirm your email/);
    expect(mail.text).toContain(`${WEB_ORIGIN}/auth/verify-email?token=`);
    const token = tokenFrom(mail.text);

    const verify = () =>
      client.request<ErrorEnvelope>({
        method: "POST",
        url: "/v1/auth/verify-email",
        body: { token },
      });
    expect((await verify()).status).toBe(204);
    expect((await me(client, session.accessToken)).body.user.emailVerified).toBe(true);

    const again = await verify();
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("token_invalid");
  });

  it("resends only while the address is unverified", async () => {
    const client = new Client(t.app);
    const { email, session } = await signUp(client, uniqueEmail("resend"));
    await latestEmail(email, /Confirm your email/);
    const resend = await client.request({
      method: "POST",
      url: "/v1/auth/verify-email/resend",
      token: session.accessToken,
    });
    expect(resend.status).toBe(204);
    await expect.poll(() => countEmails(email)).toBe(2);
  });
});

describe("sign-in", () => {
  it("gives the same answer for a wrong password and an unknown account", async () => {
    const client = new Client(t.app);
    const { email } = await signUp(client);

    const wrong = await signIn(client, email, "not-the-password");
    const unknown = await signIn(client, uniqueEmail("nobody"), PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe("invalid_credentials");

    const ok = await signIn(client, email, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it("signs in accounts imported from Supabase with bcrypt hashes and upgrades them to Argon2id", async () => {
    const email = uniqueEmail("imported");
    const admin = new pg.Client({ connectionString: t.database.adminUrl });
    await admin.connect();
    try {
      await admin.query("INSERT INTO users (email, password_hash) VALUES ($1, $2)", [
        email,
        await bcrypt.hash("old-supabase-pw", 10),
      ]);
      const res = await signIn(new Client(t.app), email, "old-supabase-pw");
      expect(res.status).toBe(200);
      const { rows } = await admin.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE email = $1",
        [email],
      );
      expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    } finally {
      await admin.end();
    }
  });

  it("rate-limits guesses against one account", async () => {
    const owner = new Client(t.app);
    const { email } = await signUp(owner);
    // Different source IP from the sign-up, so only the per-account limit applies.
    const attacker = new Client(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signIn(attacker, email, `guess-${i}`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

    const limited = await signIn(attacker, email, PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("issues access tokens that verify against the published JWKS", async () => {
    const client = new Client(t.app);
    const { session } = await signUp(client);
    const jwks = await client.request<{ keys: [] }>({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(jwks.status).toBe(200);
    const { payload } = await jwtVerify(session.accessToken, createLocalJWKSet(jwks.body), {
      issuer: "spatial-capture-api",
      audience: "spatial-capture",
    });
    expect(payload.sub).toBe(session.user.id);
  });
});

describe("refresh and sign-out", () => {
  it("rotates the refresh cookie on every refresh", async () => {
    const client = new Client(t.app);
    await signUp(client);
    const first = client.cookie(REFRESH_COOKIE);

    const res = await refresh(client);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(client.cookie(REFRESH_COOKIE)).not.toBe(first);
    expect((await me(client, res.body.accessToken)).status).toBe(200);
  });

  it("revokes the whole session when a rotated token is replayed", async () => {
    const victim = new Client(t.app);
    await signUp(victim);
    const stolen = victim.cookie(REFRESH_COOKIE)!;
    expect((await refresh(victim)).status).toBe(200);

    const thief = new Client(t.app);
    thief.setCookie(REFRESH_COOKIE, stolen);
    expect((await refresh(thief)).status).toBe(401);
    // The victim's current token belonged to the same family, so it is dead too.
    expect((await refresh(victim)).status).toBe(401);
  });

  it("refuses the refresh cookie from another site", async () => {
    const client = new Client(t.app);
    await signUp(client);
    const res = await refresh(client, "https://evil.example");
    expect(res.status).toBe(401);
    expect((await refresh(client)).status).toBe(200);
  });

  it("ends the session on sign-out", async () => {
    const client = new Client(t.app);
    await signUp(client);
    const cookie = client.cookie(REFRESH_COOKIE)!;
    const out = await client.request({
      method: "POST",
      url: "/v1/auth/sign-out",
      headers: { origin: WEB_ORIGIN },
    });
    expect(out.status).toBe(204);
    expect(client.cookie(REFRESH_COOKIE)).toBeUndefined();

    client.setCookie(REFRESH_COOKIE, cookie);
    expect((await refresh(client)).status).toBe(401);
  });

  it("requires a refresh cookie", async () => {
    const res = await refresh(new Client(t.app));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });
});

describe("password reset", () => {
  it("resets through the emailed link and signs out every existing session", async () => {
    const laptop = new Client(t.app);
    const { email } = await signUp(laptop, uniqueEmail("reset"));

    const request = await new Client(t.app).request({
      method: "POST",
      url: "/v1/auth/password-reset",
      body: { email },
    });
    expect(request.status).toBe(202);
    const token = tokenFrom((await latestEmail(email, /Reset your/)).text);

    const confirm = await new Client(t.app).request({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      body: { token, password: "a-brand-new-password" },
    });
    expect(confirm.status).toBe(204);

    expect((await refresh(laptop)).status).toBe(401);
    const fresh = new Client(t.app);
    expect((await signIn(fresh, email, PASSWORD)).status).toBe(401);
    const ok = await signIn(fresh, email, "a-brand-new-password");
    expect(ok.status).toBe(200);
    // Following the link proved the inbox, so the address is now verified.
    expect(ok.body.user.emailVerified).toBe(true);

    const reuse = await fresh.request<ErrorEnvelope>({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      body: { token, password: "yet-another-password" },
    });
    expect(reuse.status).toBe(400);
  });

  it("answers the same for unknown addresses and sends nothing", async () => {
    const email = uniqueEmail("ghost");
    const res = await new Client(t.app).request({
      method: "POST",
      url: "/v1/auth/password-reset",
      body: { email },
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
    expect(await countEmails(email)).toBe(0);
  });
});

describe("protocol", () => {
  it("echoes a sane x-request-id and replaces anything else", async () => {
    const client = new Client(t.app);
    const echoed = await client.request({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "trace-123" },
    });
    expect(echoed.headers["x-request-id"]).toBe("trace-123");
    const replaced = await client.request({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the error envelope for unknown routes and rejects malformed JSON", async () => {
    const client = new Client(t.app);
    const missing = await client.request<ErrorEnvelope>({ method: "GET", url: "/v1/nothing-here" });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");

    const malformed = await t.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).code).toBe("invalid_request");
  });
});
