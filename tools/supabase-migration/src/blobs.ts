// Files (plan §18.2 step 3): every object in the Supabase buckets is streamed
// to the Azure container of the same name, under the same key, so the paths
// stored in rows keep working. A manifest of what was copied (with each
// object's ETag and size) makes runs resumable: the bulk copy days before
// cutover, then a delta in the read-only window that copies only what's new
// or changed. Each copy is checked against the source size and MD5.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ContainerClient } from "@azure/storage-blob";
import type { Client } from "./db";

export interface SourceObject {
  bucket: string;
  name: string;
  size: number | null;
  /** Supabase's ETag, unquoted. A plain MD5 except for multipart uploads. */
  etag: string | null;
  contentType: string | null;
}

interface ManifestEntry {
  bucket: string;
  name: string;
  size: number;
  etag: string | null;
  md5: string;
  at: string;
}

/** Append-only JSON lines; the last line for a key wins. */
export class Manifest {
  private readonly entries = new Map<string, ManifestEntry>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as ManifestEntry;
      this.entries.set(`${entry.bucket}/${entry.name}`, entry);
    }
  }

  get(o: { bucket: string; name: string }): ManifestEntry | undefined {
    return this.entries.get(`${o.bucket}/${o.name}`);
  }

  /** Copied before, and unchanged since. */
  isCurrent(o: SourceObject): boolean {
    const entry = this.get(o);
    return !!entry && entry.etag === o.etag && (o.size === null || entry.size === o.size);
  }

  record(entry: ManifestEntry) {
    this.entries.set(`${entry.bucket}/${entry.name}`, entry);
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  get size() {
    return this.entries.size;
  }
}

const unquote = (etag: string | null) => (etag ? etag.replace(/^W\//, "").replace(/"/g, "") : null);
const isMd5 = (etag: string | null): etag is string => !!etag && /^[0-9a-f]{32}$/i.test(etag);

/** Objects in the given buckets, a page at a time in key order. */
export async function* listObjects(
  source: Client,
  buckets: string[],
  pageSize = 5000,
): AsyncGenerator<SourceObject[]> {
  for (const bucket of buckets) {
    let after = "";
    for (;;) {
      const { rows } = await source.query<{
        name: string;
        size: string | null;
        etag: string | null;
        mimetype: string | null;
      }>(
        `SELECT name, metadata->>'size' AS size, metadata->>'eTag' AS etag,
                metadata->>'mimetype' AS mimetype
           FROM storage.objects
          WHERE bucket_id = $1 AND name COLLATE "C" > $2 AND name NOT LIKE '%.emptyFolderPlaceholder'
          ORDER BY name COLLATE "C" LIMIT $3`,
        [bucket, after, pageSize],
      );
      if (!rows.length) break;
      yield rows.map((r) => ({
        bucket,
        name: r.name,
        size: r.size === null ? null : Number(r.size),
        etag: unquote(r.etag),
        contentType: r.mimetype,
      }));
      after = rows[rows.length - 1]!.name;
    }
  }
}

/** Supabase Storage's REST API, read with the service-role key. */
export class SupabaseStorage {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async open(o: SourceObject): Promise<{ body: Readable; contentType: string | null }> {
    const path = o.name.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(
      `${this.url.replace(/\/$/, "")}/storage/v1/object/authenticated/${encodeURIComponent(o.bucket)}/${path}`,
      {
        headers: { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      },
    );
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new HttpError(res.status, `GET ${o.bucket}/${o.name}: ${res.status}`);
    }
    return {
      body: Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      contentType: res.headers.get("content-type"),
    };
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const retryable = (err: unknown) =>
  !(err instanceof HttpError) || err.status === 429 || err.status >= 500;

export interface BlobCopyOptions {
  source: Client;
  storage: Pick<SupabaseStorage, "open">;
  /** Destination container per bucket. */
  containers: Record<string, ContainerClient>;
  manifest: Manifest;
  concurrency?: number;
  attempts?: number;
  log?: (message: string) => void;
}

export interface BlobCopyResult {
  copied: number;
  skipped: number;
  bytes: number;
  failed: { key: string; error: string }[];
}

export async function copyBlobs(options: BlobCopyOptions): Promise<BlobCopyResult> {
  const { manifest, containers } = options;
  const log = options.log ?? (() => undefined);
  const result: BlobCopyResult = { copied: 0, skipped: 0, bytes: 0, failed: [] };
  const attempts = options.attempts ?? 4;

  const copyOne = async (o: SourceObject) => {
    const container = containers[o.bucket];
    if (!container) throw new Error(`No container for bucket ${o.bucket}`);
    for (let attempt = 1; ; attempt++) {
      try {
        const copied = await streamOne(options.storage, container, o);
        manifest.record({
          bucket: o.bucket,
          name: o.name,
          size: copied.size,
          etag: o.etag,
          md5: copied.md5,
          at: new Date().toISOString(),
        });
        result.copied++;
        result.bytes += copied.size;
        return;
      } catch (err) {
        if (attempt >= attempts || !retryable(err)) {
          result.failed.push({
            key: `${o.bucket}/${o.name}`,
            error: String((err as Error).message),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  };

  for await (const page of listObjects(options.source, Object.keys(containers))) {
    const todo = page.filter((o) => {
      if (!manifest.isCurrent(o)) return true;
      result.skipped++;
      return false;
    });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency ?? 8, todo.length) }, async () => {
        while (next < todo.length) await copyOne(todo[next++]!);
      }),
    );
    log(`copied ${result.copied}, unchanged ${result.skipped}, failed ${result.failed.length}`);
  }
  return result;
}

async function streamOne(
  storage: Pick<SupabaseStorage, "open">,
  container: ContainerClient,
  o: SourceObject,
): Promise<{ size: number; md5: string }> {
  const { body, contentType } = await storage.open(o);
  const hash = createHash("md5");
  let size = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  body.on("error", (err) => counted.destroy(err));
  const blob = container.getBlockBlobClient(o.name);
  const type = o.contentType ?? contentType ?? "application/octet-stream";
  await blob.uploadStream(body.pipe(counted), 4 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: type },
  });
  const md5 = hash.digest();
  const problem =
    o.size !== null && size !== o.size
      ? `size ${size}, expected ${o.size}`
      : isMd5(o.etag) && md5.toString("hex") !== o.etag.toLowerCase()
        ? `MD5 ${md5.toString("hex")}, expected ${o.etag}`
        : null;
  if (problem) {
    await blob.deleteIfExists();
    throw new HttpError(502, `${o.bucket}/${o.name}: ${problem}`);
  }
  // Azure keeps the MD5, so the deep check (and anyone later) can verify it.
  await blob.setHTTPHeaders({ blobContentType: type, blobContentMD5: md5 });
  return { size, md5: md5.toString("hex") };
}

export interface BlobCheck {
  objects: number;
  notCopied: string[];
  /** Deep check only: in the manifest but missing or different in Azure. */
  mismatched: string[];
}

/** Every source object is in the manifest, unchanged; with `deep`, also in Azure with the same size and MD5. */
export async function checkBlobs(options: {
  source: Client;
  containers: Record<string, ContainerClient>;
  manifest: Manifest;
  deep?: boolean;
}): Promise<BlobCheck> {
  const check: BlobCheck = { objects: 0, notCopied: [], mismatched: [] };
  for await (const page of listObjects(options.source, Object.keys(options.containers))) {
    for (const o of page) {
      check.objects++;
      const key = `${o.bucket}/${o.name}`;
      if (!options.manifest.isCurrent(o)) {
        check.notCopied.push(key);
        continue;
      }
      if (!options.deep) continue;
      const entry = options.manifest.get(o)!;
      const props = await options.containers[o.bucket]!.getBlobClient(o.name)
        .getProperties()
        .catch(() => null);
      const md5 = props?.contentMD5 ? Buffer.from(props.contentMD5).toString("hex") : null;
      if (!props || props.contentLength !== entry.size || md5 !== entry.md5) {
        check.mismatched.push(key);
      }
    }
  }
  return check;
}
