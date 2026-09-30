import { describe, expect, it } from "vitest";
import { CreateScanRequestSchema, ScanListQuerySchema, UpdateScanRequestSchema } from "./scans";
import { CompleteUploadRequestSchema, MAX_FRAME_BYTES, UploadRequestSchema } from "./uploads";

describe("UploadRequestSchema", () => {
  it("accepts frames and one depth file of a supported format", () => {
    const ok = UploadRequestSchema.safeParse({
      files: [
        { kind: "frame", contentType: "image/jpeg", sizeBytes: 400_000 },
        {
          kind: "depth",
          contentType: "application/octet-stream",
          sizeBytes: 9_000_000,
          fileName: "Room.PLY",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects oversized frames, other image types, unknown depth formats and two depth files", () => {
    const frame = (over: object) => ({
      kind: "frame",
      contentType: "image/jpeg",
      sizeBytes: 1,
      ...over,
    });
    const depth = {
      kind: "depth",
      contentType: "application/octet-stream",
      sizeBytes: 1,
      fileName: "a.ply",
    };
    for (const files of [
      [frame({ sizeBytes: MAX_FRAME_BYTES + 1 })],
      [frame({ contentType: "image/gif" })],
      [{ ...depth, fileName: "room.exe" }],
      [depth, depth],
      [],
    ]) {
      expect(UploadRequestSchema.safeParse({ files }).success, JSON.stringify(files)).toBe(false);
    }
  });
});

describe("CompleteUploadRequestSchema", () => {
  const frame = { fileIndex: 0, headingDeg: 90 };

  it("defaults the sensor payload and refuses reusing a file", () => {
    expect(CompleteUploadRequestSchema.parse({ frames: [frame] }).frames[0]?.sensorPayload).toEqual(
      {},
    );
    expect(CompleteUploadRequestSchema.safeParse({ frames: [frame, frame] }).success).toBe(false);
    expect(CompleteUploadRequestSchema.safeParse({ frames: [] }).success).toBe(false);
    expect(CompleteUploadRequestSchema.safeParse({ frames: [], depthFileIndex: 0 }).success).toBe(
      true,
    );
  });
});

describe("scan requests", () => {
  it("lets the client write only capture-owned analysis_notes keys", () => {
    expect(UpdateScanRequestSchema.safeParse({ analysisNotes: { wall_ranges: [] } }).success).toBe(
      true,
    );
    expect(UpdateScanRequestSchema.safeParse({ analysisNotes: { error: "fake" } }).success).toBe(
      false,
    );
    expect(UpdateScanRequestSchema.safeParse({}).success).toBe(false);
    expect(CreateScanRequestSchema.safeParse({ analysisNotes: { deadline_at: "x" } }).success).toBe(
      false,
    );
  });

  it("coerces list query parameters and applies defaults", () => {
    expect(ScanListQuerySchema.parse({ limit: "10" })).toEqual({ sort: "newest", limit: 10 });
    expect(ScanListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(ScanListQuerySchema.safeParse({ sort: "random" }).success).toBe(false);
  });
});
