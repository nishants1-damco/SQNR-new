import { describe, expect, it } from "vitest";
import { CaptureConsentSchema, ScanRowSchema, ScanStatusSchema } from "./index";

const scan = {
  id: "7f1c1d4e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
  user_id: "0b9e6c1a-1111-4222-8333-944455556666",
  name: "Living room",
  status: "draft",
  created_at: "2026-09-30T10:00:00.000Z",
};

describe("ScanRowSchema", () => {
  it("accepts a minimal draft scan row", () => {
    expect(ScanRowSchema.parse(scan)).toMatchObject({ name: "Living room", status: "draft" });
  });

  it("rejects statuses the app never writes and empty names", () => {
    expect(ScanStatusSchema.safeParse("archived").success).toBe(false);
    expect(ScanRowSchema.safeParse({ ...scan, name: "" }).success).toBe(false);
    expect(ScanRowSchema.safeParse({ ...scan, id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("CaptureConsentSchema", () => {
  it("requires a UUID capture id and a consent version", () => {
    expect(
      CaptureConsentSchema.safeParse({ captureId: scan.id, consentVersion: "2026-09" }).success,
    ).toBe(true);
    expect(CaptureConsentSchema.safeParse({ captureId: "x", consentVersion: "" }).success).toBe(
      false,
    );
  });
});
