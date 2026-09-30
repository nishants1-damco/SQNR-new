// Mirrors migrations/0002_spatial.sql. The SQL is the source of truth; the
// drift test (schema.int.test.ts) fails if the two disagree. Numeric columns
// come back as strings (node-postgres keeps full precision); convert at the
// edge where a number is needed.
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { timestamptz, users } from "./identity";
import { geography, geometry } from "./types";

type Json = Record<string, unknown>;
const json = (name: string) => jsonb(name).$type<Json>().notNull().default({});
const owner = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });
const created = () => timestamptz("created_at").notNull().defaultNow();

export const scans = pgTable("scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: owner(),
  name: text("name").notNull().default("Untitled room"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  widthM: numeric("width_m"),
  lengthM: numeric("length_m"),
  heightM: numeric("height_m"),
  floorAreaM2: numeric("floor_area_m2"),
  aiSummary: text("ai_summary"),
  acoustics: json("acoustics"),
  depthPath: text("depth_path"),
  depthSource: text("depth_source"),
  createdAt: created(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  siteLocation: geography("site_location", "Point"),
  siteAddress: text("site_address"),
  northOffsetDeg: numeric("north_offset_deg"),
  footprint: geometry("footprint", "Polygon"),
  volumeM3: numeric("volume_m3"),
  lodLevel: smallint("lod_level").notNull().default(0),
  dimensionConfidence: json("dimension_confidence"),
  scaleReference: text("scale_reference"),
  depthProvided: boolean("depth_provided").notNull().default(false),
  analysisNotes: json("analysis_notes"),
  depthMetrics: json("depth_metrics"),
  promptVersion: text("prompt_version"),
  modelVersion: text("model_version"),
  provider: text("provider"),
  captureId: uuid("capture_id"),
});

export const scanPhotos = pgTable("scan_photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: owner(),
  storagePath: text("storage_path").notNull(),
  headingDeg: numeric("heading_deg"),
  idx: integer("idx").notNull().default(0),
  createdAt: created(),
  capturedAt: timestamptz("captured_at").notNull().defaultNow(),
  pitchDeg: numeric("pitch_deg"),
  cameraPose: geometry("camera_pose", "PointZ"),
  viewCone: geometry("view_cone", "Polygon"),
  sensorPayload: json("sensor_payload"),
  thumbnailPath: text("thumbnail_path"),
  mediaCheckedAt: timestamptz("media_checked_at"),
});

export const scanObjects = pgTable("scan_objects", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: owner(),
  label: text("label").notNull(),
  category: text("category"),
  confidence: numeric("confidence"),
  xM: numeric("x_m"),
  yM: numeric("y_m"),
  widthM: numeric("width_m"),
  depthM: numeric("depth_m"),
  heightM: numeric("height_m"),
  metadata: json("metadata"),
  createdAt: created(),
  footprint: geometry("footprint", "Polygon"),
  centroid: geometry("centroid", "PointZ"),
  attributes: json("attributes"),
});

export const scanSurfaces = pgTable("scan_surfaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: owner(),
  name: text("name").notNull(),
  kind: text("kind"),
  material: text("material"),
  areaM2: numeric("area_m2"),
  absorption: numeric("absorption"),
  reflectivity: numeric("reflectivity"),
  colorHex: text("color_hex"),
  notes: text("notes"),
  createdAt: created(),
  plane: geometry("plane", "Polygon"),
  bandAbsorption: json("band_absorption"),
});

export const scanPortals = pgTable("scan_portals", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: owner(),
  kind: text("kind").notNull().default("door"),
  wall: text("wall").notNull().default("north"),
  offsetM: numeric("offset_m"),
  widthM: numeric("width_m"),
  heightM: numeric("height_m"),
  confidence: numeric("confidence"),
  notes: text("notes"),
  createdAt: created(),
  line: geometry("line", "LineString"),
  attributes: json("attributes"),
  sillM: numeric("sill_m"),
});

export const scanLayers = pgTable("scan_layers", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  level: smallint("level").notNull(),
  name: text("name").notNull(),
  producer: text("producer"),
  payload: json("payload"),
  geom: geometry("geom", "GeometryCollection"),
  quality: numeric("quality"),
  createdAt: created(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const scanNavNodes = pgTable("scan_nav_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull().default("waypoint"),
  label: text("label"),
  point: geometry("point", "PointZ").notNull(),
  portalId: uuid("portal_id").references(() => scanPortals.id, { onDelete: "set null" }),
  metadata: json("metadata"),
  createdAt: created(),
});

export const scanNavEdges = pgTable("scan_nav_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  fromNode: uuid("from_node")
    .notNull()
    .references(() => scanNavNodes.id, { onDelete: "cascade" }),
  toNode: uuid("to_node")
    .notNull()
    .references(() => scanNavNodes.id, { onDelete: "cascade" }),
  path: geometry("path", "LineStringZ"),
  costM: numeric("cost_m"),
  traversable: boolean("traversable").notNull().default(true),
  createdAt: created(),
});

export const scanAnalyses = pgTable("scan_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  userId: owner(),
  provider: text("provider").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed", "timed_out"] }).notNull(),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
  finishedAt: timestamptz("finished_at"),
  durationMs: integer("duration_ms"),
  inputFrameCount: integer("input_frame_count"),
  inputTokenEstimate: integer("input_token_estimate"),
  outputTokenEstimate: integer("output_token_estimate"),
  costEstimateUsd: numeric("cost_estimate_usd", { precision: 10, scale: 6 }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metrics: json("metrics"),
  createdAt: created(),
});

export const featureFlags = pgTable("feature_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  payload: json("payload"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const userRateLimits = pgTable("user_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: owner(),
  bucket: text("bucket").notNull(),
  windowStartedAt: timestamptz("window_started_at").notNull().defaultNow(),
  count: integer("count").notNull().default(0),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const captureConsents = pgTable("capture_consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: owner(),
  captureId: uuid("capture_id").notNull(),
  consentVersion: text("consent_version").notNull(),
  acceptedAt: timestamptz("accepted_at").notNull().defaultNow(),
  userAgent: text("user_agent"),
  createdAt: created(),
});

export const productDimensions = pgTable("product_dimensions", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  widthM: numeric("width_m", { precision: 6, scale: 3 }),
  heightM: numeric("height_m", { precision: 6, scale: 3 }),
  depthM: numeric("depth_m", { precision: 6, scale: 3 }),
  diagonalIn: numeric("diagonal_in", { precision: 6, scale: 2 }),
  aspectRatio: text("aspect_ratio"),
  source: text("source"),
  createdAt: created(),
  brand: text("brand"),
  model: text("model"),
  imageUrl: text("image_url"),
  classification: text("classification"),
  specs: json("specs"),
  embedding: vector("embedding", { dimensions: 768 }),
});

export type UploadFileKind = "frame" | "depth";

export interface UploadSessionFile {
  index: number;
  kind: UploadFileKind;
  key: string;
  contentType: string;
  maxBytes: number;
}

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: owner(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  files: jsonb("files").$type<UploadSessionFile[]>().notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  completedAt: timestamptz("completed_at"),
  createdAt: created(),
});

export const outbox = pgTable("outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: created(),
  dispatchedAt: timestamptz("dispatched_at"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});
