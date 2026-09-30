import { describe, expect, it } from "vitest";
import {
  sniffImageType,
  stripJpegExif,
  validateImageBytes,
  MAX_UPLOAD_BYTES,
} from "./upload-validation";

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe("sniffImageType", () => {
  it("detects JPEG magic bytes", () => {
    const b = new Uint8Array(20);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    expect(sniffImageType(b)).toBe("jpeg");
  });

  it("detects PNG magic bytes", () => {
    const b = new Uint8Array(20);
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.forEach((v, i) => (b[i] = v));
    expect(sniffImageType(b)).toBe("png");
  });

  it("detects WebP with RIFF+WEBP", () => {
    const b = new Uint8Array(20);
    "RIFF".split("").forEach((c, i) => (b[i] = c.charCodeAt(0)));
    "WEBP".split("").forEach((c, i) => (b[i + 8] = c.charCodeAt(0)));
    expect(sniffImageType(b)).toBe("webp");
  });

  it("returns unknown for garbage", () => {
    expect(sniffImageType(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBe("unknown");
  });
});

describe("validateImageBytes", () => {
  it("rejects empty payloads", () => {
    expect(validateImageBytes(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects too-large payloads", () => {
    const b = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    expect(validateImageBytes(b).ok).toBe(false);
  });

  it("accepts a real-looking JPEG header", () => {
    const b = new Uint8Array(64);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    const result = validateImageBytes(b);
    expect(result.ok).toBe(true);
    expect(result.detectedType).toBe("jpeg");
  });
});

describe("stripJpegExif", () => {
  it("returns non-JPEG bytes unchanged", () => {
    const b = bytes(1, 2, 3);
    expect(stripJpegExif(b)).toBe(b);
  });

  it("removes an APP1 marker between SOI and SOS", () => {
    // SOI, APP1 (length 8: contains 6 bytes payload), then SOS + tiny scan.
    const app1Payload = [0x00, 0x08, 1, 2, 3, 4, 5, 6];
    const scan = [0xff, 0xda, 0x00, 0x02, 0x00];
    const input = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...app1Payload, ...scan]);
    const out = stripJpegExif(input);
    // Expected: SOI followed directly by SOS+scan
    expect(Array.from(out)).toEqual([0xff, 0xd8, ...scan]);
  });
});
