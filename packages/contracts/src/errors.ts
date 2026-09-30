// The one error shape every API response uses (plan §7.3). Clients branch on
// `code`, which is stable; `message` is for people and may change.
import { z } from "zod";

export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "invalid_credentials",
  "email_taken",
  "token_invalid",
  "not_found",
  "rate_limited",
  "service_unavailable",
  "internal_error",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
