// Direct-to-Blob uploads (plan §5.2, §12.3):
//   1. `issue` signs one create-only URL per file and records the keys in an
//      upload session.
//   2. The browser PUTs each file straight to storage.
//   3. `complete` checks every referenced blob exists with an acceptable size
//      and type, then records the frames in one transaction and queues the
//      media check (magic bytes, EXIF strip, thumbnail) for each.
// Image bytes never pass through the API.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  MAX_DEPTH_BYTES,
  MAX_FRAME_BYTES,
  type UploadRequest,
  type UploadSessionResponse,
} from "@spatial/contracts";
import { enqueueOutbox, OUTBOX_TOPICS, type UploadSessionFile } from "@spatial/db";
import { isAnalysisStale } from "@spatial/domain/analysis-deadline";
import { stationFrameFromPhoto } from "@spatial/domain/station-health";
import type { BlobStore } from "@spatial/storage";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { QUOTAS, QuotaService } from "../quota/quota.service";
import { type OwnedScan, ScansRepository } from "../scans/scans.repository";
import { scanPrefix } from "../scans/scans.service";
import { SCANS_BLOB_STORE } from "../storage/storage.module";

/** Upload URLs stop working after 15 minutes (plan §12.3). */
export const UPLOAD_URL_TTL_SEC = 15 * 60;
/** A session can still be completed this long after its URLs expired (slow networks). */
const COMPLETE_GRACE_MS = 60 * 60 * 1000;

const FRAME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

const safeFileName = (name: string) =>
  name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-100) || "depth";

function assertNotReconstructing(scan: OwnedScan) {
  if (scan.status === "processing" && !isAnalysisStale(scan)) {
    throw ApiError.conflict("This space is being reconstructed. Try again once it finishes.");
  }
}

interface SessionRow {
  [column: string]: unknown;
  id: string;
  files: UploadSessionFile[];
  expires_at: Date;
  completed_at: Date | null;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly scans: ScansRepository,
    private readonly quota: QuotaService,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  async issue(userId: string, scanId: string, body: UploadRequest): Promise<UploadSessionResponse> {
    await this.quota.consume(userId, QUOTAS.uploadSession);
    assertNotReconstructing(await this.scans.requireOwned(userId, scanId));

    const sessionId = randomUUID();
    const tag = sessionId.slice(0, 8);
    const prefix = scanPrefix(userId, scanId);
    const files: UploadSessionFile[] = body.files.map((file, index) =>
      file.kind === "frame"
        ? {
            index,
            kind: "frame",
            key: `${prefix}frames/${tag}-${index}.${FRAME_EXTENSIONS[file.contentType]}`,
            contentType: file.contentType,
            maxBytes: MAX_FRAME_BYTES,
          }
        : {
            index,
            kind: "depth",
            key: `${prefix}depth/${tag}-${safeFileName(file.fileName)}`,
            contentType: file.contentType,
            maxBytes: MAX_DEPTH_BYTES,
          },
    );
    const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000);
    await this.scans.db.execute(sql`
      INSERT INTO upload_sessions (id, user_id, scan_id, files, expires_at)
      VALUES (${sessionId}, ${userId}, ${scanId}, ${JSON.stringify(files)}::jsonb, ${expiresAt})`);

    const signed = await Promise.all(
      files.map(async (file) => {
        const upload = await this.blobs.presignPut(file.key, {
          contentType: file.contentType,
          expiresInSec: UPLOAD_URL_TTL_SEC,
        });
        return {
          index: file.index,
          kind: file.kind,
          key: file.key,
          upload: { url: upload.url, method: upload.method, headers: upload.headers },
        };
      }),
    );
    return { sessionId, expiresAt: expiresAt.toISOString(), files: signed };
  }

  async complete(
    userId: string,
    scanId: string,
    sessionId: string,
    body: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse> {
    assertNotReconstructing(await this.scans.requireOwned(userId, scanId));
    const session = await this.loadSession(userId, scanId, sessionId);
    this.assertCompletable(session);

    const byIndex = new Map(session.files.map((f) => [f.index, f]));
    const fileFor = (index: number, kind: UploadSessionFile["kind"]) => {
      const file = byIndex.get(index);
      if (!file || file.kind !== kind) {
        throw new ApiError(400, "invalid_request", `File ${index} is not a ${kind} in this upload`);
      }
      return file;
    };
    const frameFiles = body.frames.map((frame) => fileFor(frame.fileIndex, "frame"));
    const depthFile =
      body.depthFileIndex === undefined ? null : fileFor(body.depthFileIndex, "depth");
    await this.verifyBlobs([...frameFiles, ...(depthFile ? [depthFile] : [])]);

    return this.scans.db.transaction(async (tx) => {
      const scan = await this.scans.requireOwned(userId, scanId, tx, true);
      assertNotReconstructing(scan);
      const locked = await tx.execute<SessionRow>(
        sql`SELECT id, files, expires_at, completed_at FROM upload_sessions WHERE id = ${sessionId} FOR UPDATE`,
      );
      this.assertCompletable(locked.rows[0]!);

      const next = await tx.execute<{ next: number }>(
        sql`SELECT coalesce(max(idx), -1) + 1 AS next FROM scan_photos WHERE scan_id = ${scanId}`,
      );
      let idx = Number(next.rows[0]?.next ?? 0);
      const photos: CompleteUploadResponse["photos"] = [];
      for (const [i, frame] of body.frames.entries()) {
        const { rows } = await tx.execute<{ id: string; idx: number; storage_path: string }>(sql`
          INSERT INTO scan_photos (scan_id, user_id, storage_path, heading_deg, pitch_deg,
            sensor_payload, captured_at, idx)
          VALUES (${scanId}, ${userId}, ${frameFiles[i]!.key}, ${frame.headingDeg},
            ${frame.pitchDeg ?? null}, ${JSON.stringify(frame.sensorPayload)}::jsonb,
            coalesce(${frame.capturedAt ?? null}::timestamptz, now()), ${idx++})
          RETURNING id, idx, storage_path`);
        photos.push(rows[0]!);
      }

      // Reshoot: drop this scan's older frames from the reshot viewpoints.
      let replaced = 0;
      if (body.replaceStations?.length) {
        const stations = new Set(body.replaceStations);
        const newIds = photos.map((p) => p.id);
        const { rows: older } = await tx.execute<{
          id: string;
          heading_deg: string | null;
          sensor_payload: unknown;
          storage_path: string;
          thumbnail_path: string | null;
        }>(sql`
          SELECT id, heading_deg, sensor_payload, storage_path, thumbnail_path FROM scan_photos
          WHERE scan_id = ${scanId} AND NOT (id = ANY(${sql.param(newIds)}::uuid[]))`);
        const doomed = older.filter((p) => stations.has(stationFrameFromPhoto(p).station ?? 0));
        if (doomed.length) {
          await tx.execute(
            sql`DELETE FROM scan_photos WHERE id = ANY(${sql.param(doomed.map((p) => p.id))}::uuid[])`,
          );
          await enqueueOutbox(tx, {
            topic: OUTBOX_TOPICS.blobDelete,
            payload: {
              keys: doomed
                .flatMap((p) => [p.storage_path, p.thumbnail_path])
                .filter((k): k is string => !!k),
            },
          });
        }
        replaced = doomed.length;
      }

      let depthPath = scan.depth_path;
      if (depthFile) {
        await tx.execute(
          sql`UPDATE scans SET depth_path = ${depthFile.key}, depth_provided = true WHERE id = ${scanId}`,
        );
        if (scan.depth_path && scan.depth_path !== depthFile.key) {
          await enqueueOutbox(tx, {
            topic: OUTBOX_TOPICS.blobDelete,
            payload: { keys: [scan.depth_path] },
          });
        }
        depthPath = depthFile.key;
      }

      await tx.execute(
        sql`UPDATE upload_sessions SET completed_at = now() WHERE id = ${sessionId}`,
      );
      const used = new Set([...frameFiles, ...(depthFile ? [depthFile] : [])].map((f) => f.key));
      await enqueueOutbox(
        tx,
        // Signed but not used: remove whatever the client may have uploaded there.
        {
          topic: OUTBOX_TOPICS.blobDelete,
          payload: { keys: session.files.map((f) => f.key).filter((k) => !used.has(k)) },
        },
        ...photos.map((p) => ({ topic: OUTBOX_TOPICS.mediaProcess, payload: { photoId: p.id } })),
      );
      return { photos, replaced, depth_path: depthPath };
    });
  }

  private async loadSession(
    userId: string,
    scanId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const { rows } = await this.scans.db.execute<SessionRow>(sql`
      SELECT id, files, expires_at, completed_at FROM upload_sessions
      WHERE id = ${sessionId} AND scan_id = ${scanId} AND user_id = ${userId}`);
    if (!rows[0]) throw ApiError.notFound("Upload not found");
    return rows[0];
  }

  private assertCompletable(session: SessionRow) {
    if (session.completed_at) throw ApiError.conflict("This upload was already completed");
    if (Date.now() > new Date(session.expires_at).getTime() + COMPLETE_GRACE_MS) {
      throw ApiError.conflict("This upload has expired. Start a new one.");
    }
  }

  /** Every file must exist in storage with a type and size the session allowed. */
  private async verifyBlobs(files: UploadSessionFile[]): Promise<void> {
    const problems: { index: number; key: string; problem: string }[] = [];
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(
        files.slice(i, i + 8).map(async (file) => {
          const head = await this.blobs.head(file.key);
          const problem = !head
            ? "not uploaded"
            : head.size > file.maxBytes
              ? "too large"
              : head.contentType !== file.contentType
                ? `content type ${head.contentType ?? "missing"}, expected ${file.contentType}`
                : null;
          if (problem) problems.push({ index: file.index, key: file.key, problem });
        }),
      );
    }
    if (problems.length) {
      throw new ApiError(
        400,
        "invalid_request",
        "Some files were not uploaded correctly",
        problems.sort((a, b) => a.index - b.index),
      );
    }
  }
}
