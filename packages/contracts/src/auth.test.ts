import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PasswordResetConfirmRequestSchema,
  SignInRequestSchema,
  SignUpRequestSchema,
} from "./auth";
import { ErrorEnvelopeSchema } from "./errors";

describe("SignUpRequestSchema", () => {
  it("normalizes the email and accepts a Supabase-length password", () => {
    const parsed = SignUpRequestSchema.parse({ email: "  Alice@Example.COM ", password: "abc123" });
    expect(parsed.email).toBe("alice@example.com");
  });

  it("rejects bad emails, short passwords and oversized passwords", () => {
    expect(SignUpRequestSchema.safeParse({ email: "nope", password: "abcdef" }).success).toBe(
      false,
    );
    expect(SignUpRequestSchema.safeParse({ email: "a@b.co", password: "abc" }).success).toBe(false);
    expect(
      SignUpRequestSchema.safeParse({
        email: "a@b.co",
        password: "x".repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("SignInRequestSchema", () => {
  it("accepts any non-empty password so older accounts can still sign in", () => {
    expect(SignInRequestSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(SignInRequestSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});

describe("PasswordResetConfirmRequestSchema", () => {
  it("applies the current password rules to the new password", () => {
    const token = "t".repeat(43);
    expect(PasswordResetConfirmRequestSchema.safeParse({ token, password: "abc" }).success).toBe(
      false,
    );
    expect(
      PasswordResetConfirmRequestSchema.safeParse({ token, password: "a-better-one" }).success,
    ).toBe(true);
  });
});

describe("ErrorEnvelopeSchema", () => {
  it("only allows known error codes", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({ code: "rate_limited", message: "Slow down" }).success,
    ).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse({ code: "teapot", message: "?" }).success).toBe(false);
  });
});
