import { generateKeyPairSync } from "node:crypto";
import { loadApiConfig } from "@spatial/config";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { InvalidAccessToken, TokensService } from "./tokens.service";

const pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
};

const configWith = (env: Record<string, string> = {}) =>
  loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });

const user = { id: "0b9e6c1a-1111-4222-8333-944455556666", sessionId: "family-1" };

describe("TokensService", () => {
  it("issues EdDSA access tokens that verify, with the configured claims", async () => {
    const key = pem();
    const tokens = new TokensService(
      configWith({ JWT_PRIVATE_KEY: key.privatePem, JWT_KEY_ID: "k1" }),
    );
    const token = await tokens.issueAccessToken(user);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "k1" });
    expect(await tokens.verifyAccessToken(token)).toEqual(user);

    const { payload } = await jwtVerify(token, createLocalJWKSet(await tokens.jwks()));
    expect(payload).toMatchObject({
      sub: user.id,
      sid: user.sessionId,
      iss: "spatial-capture-api",
      aud: "spatial-capture",
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it("rejects tokens signed by another key, for another audience, or expired", async () => {
    const tokens = new TokensService(configWith());
    const stranger = new TokensService(configWith());
    await expect(tokens.verifyAccessToken(await stranger.issueAccessToken(user))).rejects.toThrow(
      InvalidAccessToken,
    );

    const otherAudience = new TokensService(configWith({ JWT_AUDIENCE: "someone-else" }));
    // Same key, different audience: build it by hand to isolate the claim check.
    const key = pem();
    const a = new TokensService(configWith({ JWT_PRIVATE_KEY: key.privatePem, JWT_KEY_ID: "k" }));
    const forbidden = await new SignJWT({ sid: "s" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k" })
      .setSubject(user.id)
      .setIssuer("spatial-capture-api")
      .setAudience("someone-else")
      .setExpirationTime("5m")
      .sign(key.privateKey);
    await expect(a.verifyAccessToken(forbidden)).rejects.toThrow(InvalidAccessToken);
    expect(otherAudience).toBeDefined();

    const expired = await new SignJWT({ sid: "s" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k" })
      .setSubject(user.id)
      .setIssuer("spatial-capture-api")
      .setAudience("spatial-capture")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key.privateKey);
    await expect(a.verifyAccessToken(expired)).rejects.toThrow(InvalidAccessToken);
  });

  it("keeps verifying tokens from the previous key during a rotation", async () => {
    const oldKey = pem();
    const newKey = pem();
    const before = new TokensService(
      configWith({ JWT_PRIVATE_KEY: oldKey.privatePem, JWT_KEY_ID: "old" }),
    );
    const issuedBefore = await before.issueAccessToken(user);

    const after = new TokensService(
      configWith({
        JWT_PRIVATE_KEY: newKey.privatePem,
        JWT_KEY_ID: "new",
        JWT_PREVIOUS_PUBLIC_KEY: oldKey.publicPem,
        JWT_PREVIOUS_KEY_ID: "old",
      }),
    );
    expect(await after.verifyAccessToken(issuedBefore)).toEqual(user);
    expect((await after.jwks()).keys.map((k) => k.kid)).toEqual(["new", "old"]);
  });

  it("refuses a non-Ed25519 signing key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(
      () => new TokensService(configWith({ JWT_PRIVATE_KEY: rsaPem, JWT_KEY_ID: "r" })),
    ).toThrow(/Ed25519/);
  });

  it("stores only a hash of opaque tokens", () => {
    const tokens = new TokensService(configWith());
    const { token, hash } = tokens.newOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });
});
