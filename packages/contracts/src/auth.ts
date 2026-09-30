// Auth and account contracts (migration plan §10). The API validates every
// request body with these, and apps/web will use the same schemas and types.
import { z } from "zod";
import { UuidSchema } from "./primitives";

/** Longest password we hash. Bounds Argon2 work so a huge body can't be a DoS. */
export const PASSWORD_MAX_LENGTH = 128;
/** Matches Supabase's default minimum, so every existing password still works. */
export const PASSWORD_MIN_LENGTH = 6;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: "Enter a valid email address" }));

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const SignUpRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const SignInRequestSchema = z.object({
  email: EmailSchema,
  // Not PasswordSchema: an old account's password may predate today's rules.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/** Single-use token from an emailed link. */
export const EmailTokenSchema = z.string().min(20).max(200);

export const VerifyEmailRequestSchema = z.object({ token: EmailTokenSchema });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const PasswordResetRequestSchema = z.object({ email: EmailSchema });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmRequestSchema = z.object({
  token: EmailTokenSchema,
  password: PasswordSchema,
});
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmRequestSchema>;

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

/**
 * Returned by sign-up, sign-in and refresh. The refresh token is never in the
 * body: it travels only in an HttpOnly cookie scoped to /v1/auth.
 */
export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  /** Seconds until `accessToken` expires. */
  expiresIn: z.number().int().positive(),
  user: UserSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const MeResponseSchema = z.object({ user: UserSchema });
export type MeResponse = z.infer<typeof MeResponseSchema>;
