// Checks each newly uploaded frame (plan §12.3): the browser can lie about a
// file's type, so the bytes are sniffed; a frame that isn't a real image is
// removed. JPEGs have their EXIF (GPS, device data) stripped in place, and
// get a small thumbnail for lists. Reuses the original app's validation and
// crop code from @spatial/domain.
import { Inject, Injectable } from "@nestjs/common";
import type { WorkerConfig } from "@spatial/config";
import { type DatabaseHandle, enqueueOutbox, OUTBOX_TOPICS } from "@spatial/db";
import { cropRegion, decodeJpeg, encodeJpeg } from "@spatial/domain/image-crop";
import { stripJpegExif, validateImageBytes } from "@spatial/domain/upload-validation";
import type { BlobStore } from "@spatial/storage";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { QueueProcessor } from "./processor";
import { QUEUE } from "./queues";
import { DATABASE_HANDLE, SCANS_BLOB_STORE, WORKER_CONFIG } from "./tokens";

/** Long edge of list thumbnails. */
export const THUMBNAIL_EDGE_PX = 320;

export type MediaResult =
  | { status: "processed"; thumbnail: string | null; exifStripped: boolean }
  | { status: "removed"; reason: string }
  | { status: "skipped"; reason: "photo gone" | "already checked" | "blob missing" };

interface PhotoRow {
  [column: string]: unknown;
  scan_id: string;
  user_id: string;
  storage_path: string;
  media_checked_at: Date | null;
}

@Injectable()
export class MediaProcessor extends QueueProcessor {
  constructor(
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
    @InjectPinoLogger(MediaProcessor.name) logger: PinoLogger,
  ) {
    super(QUEUE.media, config, config.concurrency.media, logger);
  }

  protected handle(job: Job): Promise<MediaResult> {
    if (job.name !== OUTBOX_TOPICS.mediaProcess) throw new Error(`Unknown media job ${job.name}`);
    return this.process((job.data as { photoId: string }).photoId);
  }

  async process(photoId: string): Promise<MediaResult> {
    const db = this.database.db;
    const { rows } = await db.execute<PhotoRow>(
      sql`SELECT scan_id, user_id, storage_path, media_checked_at FROM scan_photos WHERE id = ${photoId}`,
    );
    const photo = rows[0];
    if (!photo) return { status: "skipped", reason: "photo gone" };
    if (photo.media_checked_at) return { status: "skipped", reason: "already checked" };

    let bytes: Uint8Array;
    try {
      bytes = await this.blobs.get(photo.storage_path);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      await db.execute(sql`UPDATE scan_photos SET media_checked_at = now() WHERE id = ${photoId}`);
      return { status: "skipped", reason: "blob missing" };
    }

    const check = validateImageBytes(bytes);
    if (!check.ok) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM scan_photos WHERE id = ${photoId}`);
        await enqueueOutbox(tx, {
          topic: OUTBOX_TOPICS.blobDelete,
          payload: { keys: [photo.storage_path] },
        });
      });
      this.logger.warn({ photoId, reason: check.reason }, "removed an upload that isn't an image");
      return { status: "removed", reason: check.reason ?? "invalid" };
    }

    let exifStripped = false;
    let thumbnail: string | null = null;
    if (check.detectedType === "jpeg") {
      const stripped = stripJpegExif(bytes);
      if (stripped.length !== bytes.length) {
        await this.blobs.put(photo.storage_path, stripped, "image/jpeg");
        exifStripped = true;
      }
      try {
        const image = decodeJpeg(stripped);
        const small = cropRegion(
          image,
          { x0: 0, y0: 0, x1: 1, y1: 1 },
          { maxEdgePx: THUMBNAIL_EDGE_PX },
        );
        thumbnail = `${photo.user_id}/${photo.scan_id}/thumbs/${photoId}.jpg`;
        await this.blobs.put(thumbnail, encodeJpeg(small, 80), "image/jpeg");
      } catch (err) {
        // A JPEG header on undecodable data: keep the frame, skip the thumbnail.
        this.logger.warn({ err, photoId }, "could not make a thumbnail");
        thumbnail = null;
      }
    }

    const { rowCount } = await db.execute(sql`
      UPDATE scan_photos SET thumbnail_path = ${thumbnail}, media_checked_at = now()
      WHERE id = ${photoId}`);
    if (!rowCount && thumbnail) {
      // The frame was deleted while we worked: don't leave its thumbnail behind.
      await this.blobs.delete([thumbnail]);
      return { status: "skipped", reason: "photo gone" };
    }
    return { status: "processed", thumbnail, exifStripped };
  }
}
