import { Inject, Injectable } from "@nestjs/common";
import type {
  CreateScanRequest,
  PhotoUrlsResponse,
  ScanDetailResponse,
  ScanListQuery,
  ScanListResponse,
  UpdateScanRequest,
} from "@spatial/contracts";
import { enqueueOutbox, OUTBOX_TOPICS } from "@spatial/db";
import { appendRemoval, removedFrame } from "@spatial/domain/frame-removals";
import type { BlobStore } from "@spatial/storage";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { ReadRouter } from "../database/database.module";
import { SCANS_BLOB_STORE } from "../storage/storage.module";
import { ScansRepository } from "./scans.repository";

/** Read URLs live an hour, as the original app's signed URLs did. */
export const READ_URL_TTL_SEC = 60 * 60;

interface Cursor {
  s: ScanListQuery["sort"];
  v: string;
  id: string;
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decodeCursor(raw: string, sort: ScanListQuery["sort"]): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (cursor.s === sort && typeof cursor.v === "string" && /^[0-9a-f-]{36}$/.test(cursor.id)) {
      return cursor;
    }
  } catch {
    // fall through
  }
  throw new ApiError(
    400,
    "invalid_request",
    "The cursor is invalid or belongs to another sort order",
  );
}

/** Everything the API stores for one space lives under this prefix. */
export const scanPrefix = (userId: string, scanId: string) => `${userId}/${scanId}/`;

@Injectable()
export class ScansService {
  constructor(
    private readonly scans: ScansRepository,
    @Inject(SCANS_BLOB_STORE) private readonly blobs: BlobStore,
    private readonly reads: ReadRouter,
  ) {}

  async list(userId: string, query: ScanListQuery): Promise<ScanListResponse> {
    const after = query.cursor ? decodeCursor(query.cursor, query.sort) : null;
    const db = await this.reads.forUser(userId);
    // One after the other: a request holds at most one pooled connection.
    const rows = await this.scans.list(
      userId,
      query,
      after ? { value: after.v, id: after.id } : null,
      db,
    );
    const totals = await this.scans.totals(userId, db);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const items = await Promise.all(
      page.map(async ({ thumbnail_key, cursor_value: _cursor, ...item }) => ({
        ...item,
        thumbnail_url: thumbnail_key ? await this.readUrl(thumbnail_key) : null,
      })),
    );
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ s: query.sort, v: String(last.cursor_value), id: last.id })
          : null,
      totals,
    };
  }

  async create(userId: string, body: CreateScanRequest) {
    const { id, created } = await this.scans.create(userId, {
      captureId: body.captureId ?? null,
      name: body.name ?? "Untitled space",
      notes: body.notes ?? null,
      acoustics: body.acoustics ?? {},
      analysisNotes: body.analysisNotes ?? {},
      site: body.siteLocation ?? null,
      depthProvided: body.depthProvided ?? false,
      depthMetrics: body.depthMetrics ?? {},
      scaleReference: body.scaleReference ?? null,
      depthSource: body.depthSource ?? null,
    });
    return { scan: await this.scans.scanJson(userId, id), created };
  }

  async detail(userId: string, scanId: string): Promise<ScanDetailResponse> {
    // The replica, unless this user just wrote something (read-your-writes).
    const db = await this.reads.forUser(userId);
    const { scan, objects, portals, surfaces, photos } = await this.scans.detail(
      userId,
      scanId,
      db,
    );
    const signed = await Promise.all(
      photos.map(async (photo) => ({
        ...photo,
        url: await this.readUrl(String(photo["storage_path"])),
        thumbnail_url:
          typeof photo["thumbnail_path"] === "string"
            ? await this.readUrl(photo["thumbnail_path"])
            : null,
      })),
    );
    return {
      scan,
      objects: objects as ScanDetailResponse["objects"],
      portals: portals as ScanDetailResponse["portals"],
      surfaces: surfaces as ScanDetailResponse["surfaces"],
      photos: signed as ScanDetailResponse["photos"],
      urlExpiresInSec: READ_URL_TTL_SEC,
    };
  }

  async update(userId: string, scanId: string, body: UpdateScanRequest) {
    const patch: { name?: string; notes?: string | null; analysisNotes?: Record<string, unknown> } =
      {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.analysisNotes !== undefined) patch.analysisNotes = body.analysisNotes;
    await this.scans.update(userId, scanId, patch);
    return { scan: await this.scans.scanJson(userId, scanId) };
  }

  /**
   * Deletes the space. The row's cascades remove photos, objects, surfaces,
   * portals, layers, the navigation graph, analysis history and open upload
   * sessions in one transaction; its files are deleted afterwards by the
   * worker. Consent records are kept, as in the original app: they document a
   * capture session, not the space.
   */
  async remove(userId: string, scanId: string): Promise<void> {
    const prefix = scanPrefix(userId, scanId);
    await this.scans.db.transaction(async (tx) => {
      await this.scans.requireOwned(userId, scanId, tx, true);
      const keys = await this.scans.blobKeys(scanId, tx);
      await tx.execute(sql`DELETE FROM scans WHERE id = ${scanId} AND user_id = ${userId}`);
      await enqueueOutbox(
        tx,
        { topic: OUTBOX_TOPICS.blobDeletePrefix, payload: { prefix } },
        // Anything stored outside the space's folder (none today) is removed too.
        {
          topic: OUTBOX_TOPICS.blobDelete,
          payload: { keys: keys.filter((k) => !k.startsWith(prefix)) },
        },
      );
    });
  }

  /** Removes one frame and records why, so the Frames tab can explain the gap. */
  async removePhoto(userId: string, scanId: string, photoId: string): Promise<void> {
    await this.scans.db.transaction(async (tx) => {
      const scan = await this.scans.requireOwned(userId, scanId, tx, true);
      const { rows } = await tx.execute<{
        idx: number;
        heading_deg: string | null;
        sensor_payload: unknown;
        storage_path: string;
        thumbnail_path: string | null;
      }>(sql`
        DELETE FROM scan_photos WHERE id = ${photoId} AND scan_id = ${scanId}
        RETURNING idx, heading_deg, sensor_payload, storage_path, thumbnail_path`);
      const photo = rows[0];
      if (!photo) throw ApiError.notFound("Frame not found");

      const notes = appendRemoval(scan.analysis_notes, {
        at: new Date().toISOString(),
        reason: "manual",
        source: "manual",
        frames: [removedFrame(photo)],
      });
      await tx.execute(
        sql`UPDATE scans SET analysis_notes = ${JSON.stringify(notes)}::jsonb WHERE id = ${scanId}`,
      );
      await enqueueOutbox(tx, {
        topic: OUTBOX_TOPICS.blobDelete,
        payload: {
          keys: [photo.storage_path, photo.thumbnail_path].filter((k): k is string => !!k),
        },
      });
    });
  }

  /** Read URLs for the caller's own blobs; anything else is reported missing, not signed. */
  async photoUrls(userId: string, paths: string[]): Promise<PhotoUrlsResponse> {
    const unique = [...new Set(paths)];
    const owned = await this.scans.ownedBlobKeys(userId, unique);
    const urls: Record<string, string> = {};
    for (const path of unique) if (owned.has(path)) urls[path] = await this.readUrl(path);
    return {
      urls,
      missing: unique.filter((path) => !owned.has(path)),
      expiresInSec: READ_URL_TTL_SEC,
    };
  }

  private readUrl(key: string): Promise<string> {
    return this.blobs.presignGet(key, { expiresInSec: READ_URL_TTL_SEC });
  }
}
