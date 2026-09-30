// Server-side validation for user-uploaded photos.
//
// Runs on the analyze path before we hand blobs to the VLM. The browser can
// lie about MIME type (both in the fetch response and in the storage
// metadata), so we sniff the first few bytes for a real image signature
// and enforce a size cap. EXIF GPS is stripped so a shared scan doesn't
// leak the capturer's home location.
//
// This is intentionally minimal — no full EXIF parse, no re-encoding, no
// virus scan. Real image-safety pipelines live behind Cloudflare Images or
// a Lambda; this just closes the obvious holes.

const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF; second check verifies "WEBP" at offset 8
  heic: [0x00, 0x00, 0x00], // ftyp header — offset 4 check below
};

/** Max photo size we'll accept from the client. 20 MB is generous for HEIC. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type SniffedImageType = "jpeg" | "png" | "webp" | "heic" | "unknown";

export function sniffImageType(bytes: Uint8Array): SniffedImageType {
  if (bytes.length < 12) return "unknown";
  if (startsWith(bytes, MAGIC.jpeg)) return "jpeg";
  if (startsWith(bytes, MAGIC.png)) return "png";
  if (startsWith(bytes, MAGIC.webp) && ascii(bytes, 8, 4) === "WEBP") return "webp";
  // HEIC uses ISO Base Media (ftyp) — check the brand at bytes 8-12.
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") return "heic";
  }
  return "unknown";
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  return String.fromCharCode(...slice);
}

export interface UploadValidationResult {
  ok: boolean;
  reason?: string;
  detectedType?: SniffedImageType;
}

/**
 * Validate a photo blob's size + magic bytes. Returns `{ok:false, reason}`
 * so the caller can log/attach the reason to the analysis event instead of
 * throwing an exception mid-loop.
 */
export function validateImageBytes(bytes: Uint8Array): UploadValidationResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, reason: "too_large" };
  const detectedType = sniffImageType(bytes);
  if (detectedType === "unknown") return { ok: false, reason: "unknown_type" };
  return { ok: true, detectedType };
}

/**
 * Strip EXIF (GPS + metadata) from a JPEG by removing every APP1/APP marker
 * segment. Non-JPEG bytes are returned unchanged — HEIC/WebP metadata
 * removal needs a real decoder, which we don't want to run server-side.
 *
 * This is a byte-level pass: it walks the JPEG segment list, drops any
 * 0xFFE1..0xFFEF (APPn) markers, and stops at Start-Of-Scan (0xFFDA) where
 * the image data begins. Good enough for GPS/orientation/comments.
 */
export function stripJpegExif(bytes: Uint8Array): Uint8Array {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return bytes; // not JPEG
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      // Malformed — bail and return original.
      return bytes;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xda) {
      // SOS: append everything from here to end and return.
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]!);
      return new Uint8Array(out);
    }
    // Standalone markers (RSTn, SOI, EOI) have no length payload.
    if (marker >= 0xd0 && marker <= 0xd9) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2]! << 8) | bytes[i + 3]!) & 0xffff;
    // APPn markers 0xE0..0xEF — drop them. That includes APP1 (Exif/XMP)
    // and APP0 (JFIF); JFIF is harmless but removing it is fine for our
    // use case since we only display JPEGs through <img> which doesn't
    // require JFIF.
    if (marker >= 0xe0 && marker <= 0xef) {
      i += 2 + len;
      continue;
    }
    for (let j = i; j < i + 2 + len; j++) out.push(bytes[j]!);
    i += 2 + len;
  }
  return new Uint8Array(out);
}
