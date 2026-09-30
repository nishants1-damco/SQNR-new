// Object storage behind one small interface (migration plan §12.2), so the
// API and worker never touch the Azure SDK directly and tests can swap in a
// fake. Keys are paths inside one container, e.g. `{userId}/{scanId}/frames/x.jpg`.

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface BlobHead {
  size: number;
  contentType: string | null;
  etag: string | null;
}

export interface BlobStore {
  /**
   * A create-only upload URL for exactly one blob. It can't overwrite an
   * existing blob, read anything, or touch any other key (plan §12.3).
   */
  presignPut(
    key: string,
    options: { contentType: string; expiresInSec: number },
  ): Promise<PresignedUpload>;
  /** A read-only URL for exactly one blob. */
  presignGet(
    key: string,
    options: { expiresInSec: number; downloadName?: string },
  ): Promise<string>;
  /** Size and content type, or null if the blob doesn't exist. */
  head(key: string): Promise<BlobHead | null>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes the keys that exist; missing keys are ignored. Returns how many were deleted. */
  delete(keys: string[]): Promise<number>;
  /** Deletes every blob whose key starts with `prefix`. Returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Keys are built by the server from ids; anything else is a bug worth failing loudly on. */
export function assertSafeKey(key: string): void {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\")
  ) {
    throw new Error(`Unsafe blob key: ${JSON.stringify(key)}`);
  }
}
