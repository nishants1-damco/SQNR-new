import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { PasswordsService } from "./passwords.service";

const passwords = new PasswordsService();

describe("PasswordsService", () => {
  it("hashes with Argon2id at the current parameters and verifies", async () => {
    const hash = await passwords.hash("correct horse");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.verify(hash, "correct horse")).toEqual({ ok: true, needsRehash: false });
    expect(await passwords.verify(hash, "wrong horse")).toEqual({ ok: false, needsRehash: false });
  });

  it("accepts Supabase bcrypt hashes and asks for an Argon2id re-hash", async () => {
    // Supabase stores bcrypt with cost 10 and the $2a$ prefix.
    const legacy = await bcrypt.hash("imported-password", 10);
    expect(legacy).toMatch(/^\$2[ab]\$10\$/);
    expect(await passwords.verify(legacy, "imported-password")).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(await passwords.verify(legacy, "nope")).toEqual({ ok: false, needsRehash: false });
  });

  it("asks for a re-hash when Argon2 parameters are older than today's", async () => {
    const { hash } = await import("@node-rs/argon2");
    const weaker = await hash("pw-123456", { memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(await passwords.verify(weaker, "pw-123456")).toEqual({ ok: true, needsRehash: true });
  });

  it("rejects accounts without a password and unknown hash formats", async () => {
    expect(await passwords.verify(null, "anything")).toEqual({ ok: false, needsRehash: false });
    expect(await passwords.verify("plaintext", "plaintext")).toEqual({
      ok: false,
      needsRehash: false,
    });
  });
});
