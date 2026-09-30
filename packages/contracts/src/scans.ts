// Wire contracts for the spaces/scans domain. Server functions and the
// browser client both validate through these — the goal is that a request
// never reaches the DB with a shape the DB won't like, and a response
// never reaches React with a shape the components don't expect.
//
// Keep these tight: no `passthrough()`, no `any`. Add optional fields
// rather than loosening existing ones.
import { z } from "zod";
import { UuidSchema } from "./primitives";

// Matches the values the app writes to `scans.status` (column default `draft`).
export const ScanStatusSchema = z.enum(["draft", "processing", "ready", "failed"]);

// --- Space (scan) ---------------------------------------------------------
export const ScanRowSchema = z.object({
  id: UuidSchema,
  user_id: UuidSchema,
  name: z.string().min(1).max(120),
  notes: z.string().max(4000).nullable().optional(),
  status: ScanStatusSchema,
  width_m: z.number().nullable().optional(),
  length_m: z.number().nullable().optional(),
  height_m: z.number().nullable().optional(),
  floor_area_m2: z.number().nullable().optional(),
  ai_summary: z.string().nullable().optional(),
  analysis_notes: z.unknown().optional(),
  depth_path: z.string().nullable().optional(),
  depth_source: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  prompt_version: z.string().nullable().optional(),
  model_version: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  capture_id: z.string().uuid().nullable().optional(),
});
export type ScanRow = z.infer<typeof ScanRowSchema>;

// --- Consent --------------------------------------------------------------
export const CaptureConsentSchema = z.object({
  captureId: UuidSchema,
  consentVersion: z.string().min(1).max(40),
  userAgent: z.string().max(500).optional(),
});
export type CaptureConsentInput = z.infer<typeof CaptureConsentSchema>;
