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

// --- API resources (phase 2) ------------------------------------------------
// Rows keep the database column names (snake_case) so the web app's existing
// components keep working unchanged. Response schemas type the fields clients
// rely on and pass the rest through, so a column added later never breaks
// serialization of older rows.

const Json = z.record(z.string(), z.unknown());
/** GeoJSON geometry as produced by PostGIS, or null. */
const Geometry = z.looseObject({ type: z.string() }).nullable();

export const ScanRecordSchema = z.looseObject({
  id: UuidSchema,
  user_id: UuidSchema,
  name: z.string(),
  status: z.string(),
  created_at: z.string(),
  analysis_notes: Json,
  acoustics: Json,
  footprint: Geometry.optional(),
  site_location: Geometry.optional(),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

const ChildRow = z.looseObject({ id: UuidSchema, scan_id: UuidSchema });

export const PhotoRecordSchema = ChildRow.extend({
  storage_path: z.string(),
  idx: z.number().int(),
  /** Read URL for the frame, valid for `urlExpiresInSec`. */
  url: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
});
export type PhotoRecord = z.infer<typeof PhotoRecordSchema>;

export const ScanDetailResponseSchema = z.object({
  scan: ScanRecordSchema,
  objects: z.array(ChildRow),
  portals: z.array(ChildRow),
  surfaces: z.array(ChildRow),
  photos: z.array(PhotoRecordSchema),
  urlExpiresInSec: z.number().int(),
});
export type ScanDetailResponse = z.infer<typeof ScanDetailResponseSchema>;

export const SCAN_SORTS = ["newest", "oldest", "name", "area"] as const;

export const ScanListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: ScanStatusSchema.optional(),
  sort: z.enum(SCAN_SORTS).default("newest"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ScanListQuery = z.infer<typeof ScanListQuerySchema>;

export const ScanListItemSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  status: z.string(),
  width_m: z.number().nullable(),
  length_m: z.number().nullable(),
  height_m: z.number().nullable(),
  floor_area_m2: z.number().nullable(),
  site_address: z.string().nullable(),
  ai_summary: z.string().nullable(),
  rt60_s: z.number().nullable(),
  created_at: z.string(),
  object_count: z.number().int(),
  portal_count: z.number().int(),
  thumbnail_url: z.string().nullable(),
});
export type ScanListItem = z.infer<typeof ScanListItemSchema>;

export const ScanListResponseSchema = z.object({
  items: z.array(ScanListItemSchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Across all of the caller's spaces, ignoring filters. */
  totals: z.object({ count: z.number().int(), floorAreaM2: z.number() }),
});
export type ScanListResponse = z.infer<typeof ScanListResponseSchema>;

/**
 * Keys of `analysis_notes` the capture client owns. Everything else in that
 * column is written by the server (analysis runs, frame removals).
 */
export const CAPTURE_NOTE_KEYS = [
  "geo",
  "track",
  "wall_ranges",
  "measured_shell",
  "walk_legs",
  "station_seeds",
  "station_geometry",
  "stations",
  "capture_mode",
  "reshoots",
] as const;

/** Capture-owned keys only (unknown keys are rejected), at most 256 KB. */
export const CaptureNotesSchema = z
  .strictObject(Object.fromEntries(CAPTURE_NOTE_KEYS.map((k) => [k, z.unknown().optional()])))
  .refine((notes) => JSON.stringify(notes).length <= 256 * 1024, "analysisNotes is too large");

export const CreateScanRequestSchema = z.object({
  /** Client-generated id for the capture session; repeating it returns the same scan. */
  captureId: UuidSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(4000).nullable().optional(),
  acoustics: Json.refine(
    (v) => JSON.stringify(v).length <= 256 * 1024,
    "acoustics is too large",
  ).optional(),
  analysisNotes: CaptureNotesSchema.optional(),
  siteLocation: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
    .optional(),
  depthProvided: z.boolean().optional(),
  depthMetrics: Json.optional(),
  scaleReference: z.string().max(100).optional(),
  depthSource: z.string().max(40).nullable().optional(),
});
export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;

export const UpdateScanRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(4000).nullable().optional(),
    /** Merged into analysis_notes key by key; only capture-owned keys. */
    analysisNotes: CaptureNotesSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");
export type UpdateScanRequest = z.infer<typeof UpdateScanRequestSchema>;

export const ScanResponseSchema = z.object({ scan: ScanRecordSchema });
export type ScanResponse = z.infer<typeof ScanResponseSchema>;

export const ScanParamsSchema = z.object({ id: UuidSchema });
export const PhotoParamsSchema = z.object({ id: UuidSchema, photoId: UuidSchema });

export const PhotoUrlsRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(1024)).min(1).max(200),
});
export const PhotoUrlsResponseSchema = z.object({
  urls: z.record(z.string(), z.string()),
  /** Requested paths that don't belong to the caller (or don't exist). */
  missing: z.array(z.string()),
  expiresInSec: z.number().int(),
});
export type PhotoUrlsResponse = z.infer<typeof PhotoUrlsResponseSchema>;

export const EXPORT_FORMATS = ["all", "geojson", "postgis", "layers", "imdf", "usd"] as const;
export const ExportQuerySchema = z.object({ format: z.enum(EXPORT_FORMATS).default("all") });

export const AddressRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export const AddressResponseSchema = z.object({ address: z.string().nullable() });

export const GeocodeQuerySchema = z.object({ address: z.string().trim().min(4).max(300) });
export const GeocodeResponseSchema = z.object({
  result: z.object({ lat: z.number(), lon: z.number() }).nullable(),
});

export const ConsentResponseSchema = z.object({ ok: z.literal(true) });

export const FlagsResponseSchema = z.object({ flags: z.record(z.string(), z.boolean()) });
export type FlagsResponse = z.infer<typeof FlagsResponseSchema>;
