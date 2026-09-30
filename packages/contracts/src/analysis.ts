// Analysis runs (migration plan §9, Appendix A): queue a run, follow it, and
// the on-demand privacy sweep. Replaces the `analyzeScan` and
// `purgePeopleFrames` server functions, which held a request open for the
// whole run.
import { z } from "zod";
import { UuidSchema } from "./primitives";
import { ScanStatusSchema } from "./scans";

/** "ollama" is the local open-source provider (development only, decision D12). */
export const AnalysisProviderSchema = z.enum(["claude", "ollama"]);
export type AnalysisProvider = z.infer<typeof AnalysisProviderSchema>;

export const StartAnalysisRequestSchema = z.object({
  /** The capture session: a retried submit with the same id is recognised. */
  captureId: UuidSchema.optional(),
  /** Defaults to the environment's provider; production accepts only `claude`. */
  provider: AnalysisProviderSchema.optional(),
});
export type StartAnalysisRequest = z.infer<typeof StartAnalysisRequestSchema>;

export const StartAnalysisResponseSchema = z.object({
  /**
   * queued: a new run was queued (202). already_running: a run is in progress
   * within its deadline; follow that one. duplicate: this capture id already
   * belongs to another space, `scanId` names it.
   */
  outcome: z.enum(["queued", "already_running", "duplicate"]),
  scanId: UuidSchema,
  analysisId: UuidSchema.nullable(),
  provider: AnalysisProviderSchema.nullable(),
  model: z.string().nullable(),
});
export type StartAnalysisResponse = z.infer<typeof StartAnalysisResponseSchema>;

export const ANALYSIS_STAGES = [
  "queued",
  "load",
  "detect",
  "catalog",
  "verify",
  "pass1",
  "pass2",
  "persist",
  "retrying",
  "done",
  "failed",
] as const;
export const AnalysisStageSchema = z.enum(ANALYSIS_STAGES);

export const AnalysisRunSchema = z.object({
  id: UuidSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "timed_out"]),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  attempts: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  costEstimateUsd: z.number().nullable(),
  errorCode: z.string().nullable(),
});

export const AnalysisStatusResponseSchema = z.object({
  scanId: UuidSchema,
  scanStatus: ScanStatusSchema,
  /** Latest stage the run reported; null before the first run. */
  stage: z.string().nullable(),
  progressPct: z.number().nullable(),
  /** When a run in `processing` counts as stuck (the stalled-scan sweep's rule). */
  deadlineAt: z.string().nullable(),
  error: z.string().nullable(),
  run: AnalysisRunSchema.nullable(),
});
export type AnalysisStatusResponse = z.infer<typeof AnalysisStatusResponseSchema>;

/** One progress message on `GET /v1/scans/:id/analysis/events` (SSE `data:`). */
export const AnalysisEventSchema = z.object({
  scanId: UuidSchema,
  analysisId: UuidSchema,
  stage: AnalysisStageSchema,
  pct: z.number(),
  message: z.string(),
});
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

/** Redis pub/sub channel the worker publishes a scan's progress on (plan §9.6). */
export const analysisEventsChannel = (queuePrefix: string, scanId: string) =>
  `${queuePrefix}:scan:${scanId}:events`;

export const PrivacyPurgeResponseSchema = z.object({
  status: z.literal("queued"),
  requestedAt: z.string(),
});
export type PrivacyPurgeResponse = z.infer<typeof PrivacyPurgeResponseSchema>;
