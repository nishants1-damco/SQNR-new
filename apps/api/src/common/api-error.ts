import type { ErrorCode } from "@spatial/contracts";

/**
 * An error with a stable code and status, rendered as the standard error
 * envelope `{ code, message, details? }` by ApiExceptionFilter.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    /** Sent as the Retry-After header (seconds). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static unauthorized(message = "Sign in to continue") {
    return new ApiError(401, "unauthorized", message);
  }

  static invalidCredentials() {
    return new ApiError(401, "invalid_credentials", "Invalid email or password");
  }

  static notFound(message = "Not found") {
    return new ApiError(404, "not_found", message);
  }

  static conflict(message: string) {
    return new ApiError(409, "conflict", message);
  }

  static tokenInvalid(message = "This link is invalid or has expired") {
    return new ApiError(400, "token_invalid", message);
  }

  static rateLimited(retryAfterSeconds: number) {
    return new ApiError(
      429,
      "rate_limited",
      `Too many attempts. Try again in ${retryAfterSeconds}s.`,
      undefined,
      retryAfterSeconds,
    );
  }

  static unavailable(message = "Temporarily unavailable. Try again shortly.") {
    return new ApiError(503, "service_unavailable", message, undefined, 30);
  }
}
