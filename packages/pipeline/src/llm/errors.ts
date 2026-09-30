// Failures the pipeline and the job runner react to differently (plan §9.1):
// `retryable` decides whether the BullMQ job is retried with backoff;
// `tryOtherModel` decides whether the reconstruction falls back to the
// fallback model (the original callWithFallback rule: rate limits, bad keys
// and an unreachable local model won't improve on another model).
export type LlmErrorCode =
  | "rate_limited"
  | "auth"
  | "provider_unavailable"
  | "provider_rejected"
  | "refusal"
  | "truncated"
  | "local_unreachable"
  | "capacity"
  | "invalid_json";

const TRY_OTHER_MODEL: Record<LlmErrorCode, boolean> = {
  rate_limited: false,
  auth: false,
  local_unreachable: false,
  capacity: false,
  provider_unavailable: true,
  provider_rejected: true,
  refusal: true,
  truncated: true,
  invalid_json: true,
};

const RETRYABLE: Record<LlmErrorCode, boolean> = {
  rate_limited: true,
  provider_unavailable: true,
  local_unreachable: true,
  capacity: true,
  auth: false,
  provider_rejected: false,
  refusal: false,
  truncated: false,
  invalid_json: false,
};

export class LlmError extends Error {
  readonly retryable: boolean;
  readonly tryOtherModel: boolean;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.retryable = RETRYABLE[code];
    this.tryOtherModel = TRY_OTHER_MODEL[code];
  }
}

/** A failure outside the model boundary, e.g. "no usable frames". */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * Whether a failure is worth another job attempt. Model failures say so
 * themselves; pipeline failures ("no usable frames") are permanent unless
 * marked otherwise; anything else (a dropped database connection, a blob
 * timeout) is usually transient.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmError || err instanceof PipelineError) return err.retryable;
  return true;
}

/** Stable code for `scan_analyses.error_code`. */
export function errorCode(err: unknown): string {
  if (err instanceof LlmError || err instanceof PipelineError) return err.code;
  return "internal";
}
