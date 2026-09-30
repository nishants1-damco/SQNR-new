// In-memory BlobStore for unit tests. Presigned URLs are opaque fakes: tests
// that need real HTTP uploads use Azurite instead.
import { assertSafeKey, type BlobHead, type BlobStore, type PresignedUpload } from "./blob-store";

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { body: Uint8Array; contentType: string }>();

  async presignPut(
    key: string,
    options: { contentType: string; expiresInSec: number },
  ): Promise<PresignedUpload> {
    assertSafeKey(key);
    return {
      url: `memory://put/${key}`,
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": options.contentType },
      expiresAt: new Date(Date.now() + options.expiresInSec * 1000),
    };
  }

  async presignGet(key: string): Promise<string> {
    assertSafeKey(key);
    return `memory://get/${key}`;
  }

  async head(key: string): Promise<BlobHead | null> {
    const blob = this.blobs.get(key);
    return blob ? { size: blob.body.length, contentType: blob.contentType, etag: null } : null;
  }

  async get(key: string): Promise<Uint8Array> {
    const blob = this.blobs.get(key);
    if (!blob) throw Object.assign(new Error(`No blob ${key}`), { statusCode: 404 });
    return blob.body;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertSafeKey(key);
    this.blobs.set(key, { body, contentType });
  }

  async delete(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of new Set(keys)) if (this.blobs.delete(key)) deleted++;
    return deleted;
  }

  async deletePrefix(prefix: string): Promise<number> {
    return this.delete([...this.blobs.keys()].filter((key) => key.startsWith(prefix)));
  }
}
