// Direct-to-Blob uploads (migration plan §5.2, §12.3). The API signs one
// create-only URL per file, the browser PUTs the bytes straight to storage,
// then `complete` verifies each blob and records the frames.
import { z } from "zod";
import { UuidSchema } from "./primitives";

/** Same cap as the original app's upload validation (20 MB). */
export const MAX_FRAME_BYTES = 20 * 1024 * 1024;
/** Depth exports (PLY/OBJ/glTF) can be large; one PUT handles this size. */
export const MAX_DEPTH_BYTES = 500 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 200;

export const FRAME_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
/** Depth files the capture flow can import (see depth-import in the web app). */
export const DEPTH_EXTENSIONS = ["ply", "obj", "glb", "gltf", "usdz"] as const;

const FrameFile = z.object({
  kind: z.literal("frame"),
  contentType: z.enum(FRAME_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_FRAME_BYTES),
});

const DepthFile = z.object({
  kind: z.literal("depth"),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, "Not a content type"),
  sizeBytes: z.number().int().min(1).max(MAX_DEPTH_BYTES),
  fileName: z
    .string()
    .min(3)
    .max(200)
    .refine(
      (name) =>
        (DEPTH_EXTENSIONS as readonly string[]).includes(
          name.split(".").pop()?.toLowerCase() ?? "",
        ),
      `Depth files must be ${DEPTH_EXTENSIONS.join(", ")}`,
    ),
});

export const UploadRequestSchema = z
  .object({
    files: z
      .array(z.discriminatedUnion("kind", [FrameFile, DepthFile]))
      .min(1)
      .max(MAX_FILES_PER_UPLOAD),
  })
  .refine(
    (body) => body.files.filter((f) => f.kind === "depth").length <= 1,
    "At most one depth file per upload",
  );
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const UploadSessionResponseSchema = z.object({
  sessionId: UuidSchema,
  /** Upload URLs stop working at this time. */
  expiresAt: z.string(),
  files: z.array(
    z.object({
      index: z.number().int(),
      kind: z.enum(["frame", "depth"]),
      key: z.string(),
      upload: z.object({
        url: z.string(),
        method: z.literal("PUT"),
        headers: z.record(z.string(), z.string()),
      }),
    }),
  ),
});
export type UploadSessionResponse = z.infer<typeof UploadSessionResponseSchema>;

export const UploadSessionParamsSchema = z.object({ id: UuidSchema, sessionId: UuidSchema });

const Json = z.record(z.string(), z.unknown());

export const CompleteUploadRequestSchema = z
  .object({
    frames: z
      .array(
        z.object({
          /** Index of the file in the upload session. */
          fileIndex: z.number().int().min(0),
          headingDeg: z.number().min(-360).max(720).nullable(),
          pitchDeg: z.number().min(-180).max(180).nullable().optional(),
          capturedAt: z.iso.datetime({ offset: true }).optional(),
          sensorPayload: Json.refine(
            (v) => JSON.stringify(v).length <= 64 * 1024,
            "sensorPayload is too large",
          ).default({}),
        }),
      )
      .max(MAX_FILES_PER_UPLOAD),
    depthFileIndex: z.number().int().min(0).optional(),
    /**
     * Reshoot: after the new frames are saved, the scan's other frames from
     * these viewpoints are removed (station numbers as in sensor_payload).
     */
    replaceStations: z.array(z.number().int().min(0).max(64)).max(65).optional(),
  })
  .refine((b) => b.frames.length > 0 || b.depthFileIndex !== undefined, "Nothing to complete")
  .refine(
    (b) => new Set(b.frames.map((f) => f.fileIndex)).size === b.frames.length,
    "Each file can be used once",
  );
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

export const CompleteUploadResponseSchema = z.object({
  photos: z.array(z.object({ id: UuidSchema, idx: z.number().int(), storage_path: z.string() })),
  /** Frames removed because their viewpoint was reshot. */
  replaced: z.number().int(),
  depth_path: z.string().nullable(),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponseSchema>;
