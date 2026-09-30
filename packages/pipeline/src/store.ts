// Database access for analysis runs: run bookkeeping, checkpoints, and the
// single transaction that writes a finished analysis (plan §9.4). Replaces
// the Supabase calls in `analyzeScan` and `analysis-event.ts`.
//
// A run owns its scan while `scans.analysis_notes.analysis_id` names it and
// the scan is `processing`. Every write re-checks that, so a run that was
// swept as stalled, or superseded by a newer one, can never overwrite it.
import { type Database, enqueueOutbox, OUTBOX_TOPICS, type Transaction } from "@spatial/db";
import { appendRemoval, removedFrame } from "@spatial/domain/frame-removals";
import { sanitizeText } from "@spatial/domain/sanitize";
import { sql } from "drizzle-orm";
import type { LlmCall, UsageSummary } from "./llm/usage";
import type {
  FramePoseRow,
  NavEdgeRow,
  NavNodeRow,
  ObjectRow,
  PortalRow,
  SurfaceRow,
} from "./rows";
import type { PhotoRow, ScanRow } from "./scan-inputs";

type Executor = Database | Transaction;

export interface RunRef {
  analysisId: string;
  scanId: string;
  userId: string;
}

export interface Checkpoint<T = unknown> {
  data: T;
  /** Model calls made while producing this stage (restored into the run's usage). */
  calls: LlmCall[];
}

export type RunState = { kind: "ready"; attempts: number } | { kind: "gone"; reason: string };

const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

export class AnalysisStore {
  constructor(readonly db: Database) {}

  /**
   * Starts (or resumes) a run: checks it still owns its scan and counts the
   * attempt. "gone" means another run, the stalled-scan sweep or a deletion
   * got there first; the job should stop without writing anything.
   */
  async startRun(run: RunRef): Promise<RunState> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ status: string }>(sql`
        SELECT status FROM scan_analyses WHERE id = ${run.analysisId} FOR UPDATE`);
      const status = rows[0]?.status;
      if (!status) return { kind: "gone", reason: "run deleted" };
      if (status !== "queued" && status !== "running") {
        return { kind: "gone", reason: `run already ${status}` };
      }
      if (!(await this.ownsScan(tx, run))) {
        await tx.execute(sql`
          UPDATE scan_analyses SET status = 'failed', finished_at = now(),
            error_code = 'superseded', error_message = 'The scan was re-analysed or swept'
          WHERE id = ${run.analysisId}`);
        return { kind: "gone", reason: "scan no longer owned by this run" };
      }
      const updated = await tx.execute<{ attempts: number }>(sql`
        UPDATE scan_analyses SET status = 'running', attempts = attempts + 1
        WHERE id = ${run.analysisId} RETURNING attempts`);
      return { kind: "ready", attempts: updated.rows[0]?.attempts ?? 1 };
    });
  }

  private async ownsScan(executor: Executor, run: RunRef, lock = false): Promise<boolean> {
    const { rows } = await executor.execute<{ id: string }>(sql`
      SELECT id FROM scans
      WHERE id = ${run.scanId} AND user_id = ${run.userId} AND status = 'processing'
        AND analysis_notes->>'analysis_id' = ${run.analysisId}
      ${lock ? sql`FOR UPDATE` : sql``}`);
    return rows.length > 0;
  }

  async loadScan(run: RunRef): Promise<ScanRow> {
    const { rows } = await this.db.execute<ScanRow & Record<string, unknown>>(sql`
      SELECT id, user_id, name, notes, status, acoustics, analysis_notes, depth_metrics, depth_source
      FROM scans WHERE id = ${run.scanId} AND user_id = ${run.userId}`);
    const scan = rows[0];
    if (!scan) throw new Error("Space not found");
    return scan;
  }

  async loadPhotos(scanId: string): Promise<PhotoRow[]> {
    const { rows } = await this.db.execute<PhotoRow & Record<string, unknown>>(sql`
      SELECT id, idx, storage_path, thumbnail_path, heading_deg::float8 AS heading_deg,
             to_jsonb(captured_at) #>> '{}' AS captured_at, sensor_payload
      FROM scan_photos WHERE scan_id = ${scanId} ORDER BY idx, id`);
    return rows;
  }

  async checkpoints(analysisId: string): Promise<Map<string, Checkpoint>> {
    const { rows } = await this.db.execute<{ stage: string; payload: Checkpoint }>(sql`
      SELECT stage, payload FROM analysis_checkpoints WHERE analysis_id = ${analysisId}`);
    return new Map(rows.map((r) => [r.stage, r.payload]));
  }

  async saveCheckpoint(analysisId: string, stage: string, checkpoint: Checkpoint): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO analysis_checkpoints (analysis_id, stage, payload)
      VALUES (${analysisId}, ${stage}, ${jsonb(checkpoint)})
      ON CONFLICT (analysis_id, stage) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`);
  }

  async clearCheckpoints(analysisId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM analysis_checkpoints WHERE analysis_id = ${analysisId}`);
  }

  /** Where the run is, for `GET /status` (plan §9.6). Only while the run owns the scan. */
  async setStage(run: RunRef, stage: string, pct: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE scans SET analysis_notes = analysis_notes || ${jsonb({ stage, progress_pct: pct })}
      WHERE id = ${run.scanId} AND status = 'processing'
        AND analysis_notes->>'analysis_id' = ${run.analysisId}`);
  }

  /**
   * Writes a finished analysis in one transaction: replaces the scan's
   * objects, surfaces, portals, navigation graph and layers, stores frame
   * poses, removes frames with people in them (their files go through the
   * outbox), marks the scan ready and closes the run. Returns false if the
   * run no longer owns the scan, in which case nothing was written.
   */
  async persist(run: RunRef, bundle: PersistBundle): Promise<boolean> {
    const { scanId, userId } = run;
    return this.db.transaction(async (tx) => {
      if (!(await this.ownsScan(tx, run, true))) return false;
      const { rows: current } = await tx.execute<{ analysis_notes: Record<string, unknown> }>(
        sql`SELECT analysis_notes FROM scans WHERE id = ${scanId}`,
      );
      const previousNotes = current[0]?.analysis_notes ?? {};

      for (const table of [
        "scan_layers",
        "scan_nav_edges",
        "scan_nav_nodes",
        "scan_objects",
        "scan_surfaces",
        "scan_portals",
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE scan_id = ${scanId}`);
      }

      if (bundle.objects.length) {
        await tx.execute(sql`
          INSERT INTO scan_objects (scan_id, user_id, label, category, confidence, x_m, y_m,
            width_m, depth_m, height_m, footprint, centroid, attributes, metadata)
          SELECT ${scanId}, ${userId}, r.label, r.category, r.confidence, r.x_m, r.y_m,
            r.width_m, r.depth_m, r.height_m, ST_GeomFromText(r.footprint, 0),
            ST_GeomFromText(r.centroid, 0), r.attributes, r.metadata
          FROM jsonb_to_recordset(${jsonb(bundle.objects)}) AS r(label text, category text,
            confidence numeric, x_m numeric, y_m numeric, width_m numeric, depth_m numeric,
            height_m numeric, footprint text, centroid text, attributes jsonb, metadata jsonb)`);
      }
      if (bundle.surfaces.length) {
        await tx.execute(sql`
          INSERT INTO scan_surfaces (scan_id, user_id, name, kind, material, area_m2, absorption,
            reflectivity, color_hex, notes, plane, band_absorption)
          SELECT ${scanId}, ${userId}, r.name, r.kind, r.material, r.area_m2, r.absorption,
            r.reflectivity, r.color_hex, r.notes, ST_GeomFromText(r.plane, 0), r.band_absorption
          FROM jsonb_to_recordset(${jsonb(bundle.surfaces)}) AS r(name text, kind text,
            material text, area_m2 numeric, absorption numeric, reflectivity numeric,
            color_hex text, notes text, plane text, band_absorption jsonb)`);
      }
      if (bundle.portals.length) {
        await tx.execute(sql`
          INSERT INTO scan_portals (id, scan_id, user_id, kind, wall, offset_m, width_m, height_m,
            sill_m, confidence, notes, line, attributes)
          SELECT r.id, ${scanId}, ${userId}, r.kind, r.wall, r.offset_m, r.width_m, r.height_m,
            r.sill_m, r.confidence, r.notes, ST_GeomFromText(r.line, 0), r.attributes
          FROM jsonb_to_recordset(${jsonb(bundle.portals)}) AS r(id uuid, kind text, wall text,
            offset_m numeric, width_m numeric, height_m numeric, sill_m numeric,
            confidence numeric, notes text, line text, attributes jsonb)`);
      }
      await tx.execute(sql`
        INSERT INTO scan_nav_nodes (id, scan_id, user_id, kind, label, point, portal_id, metadata)
        SELECT r.id, ${scanId}, ${userId}, r.kind, r.label, ST_GeomFromText(r.point, 0),
          r.portal_id, r.metadata
        FROM jsonb_to_recordset(${jsonb(bundle.navNodes)}) AS r(id uuid, kind text, label text,
          point text, portal_id uuid, metadata jsonb)`);
      if (bundle.navEdges.length) {
        await tx.execute(sql`
          INSERT INTO scan_nav_edges (scan_id, user_id, from_node, to_node, path, cost_m, traversable)
          SELECT ${scanId}, ${userId}, r.from_node, r.to_node, ST_GeomFromText(r.path, 0),
            r.cost_m, r.traversable
          FROM jsonb_to_recordset(${jsonb(bundle.navEdges)}) AS r(from_node uuid, to_node uuid,
            path text, cost_m numeric, traversable boolean)`);
      }
      if (bundle.framePoses.length) {
        await tx.execute(sql`
          UPDATE scan_photos p SET camera_pose = ST_GeomFromText(r.camera_pose, 0),
            view_cone = ST_GeomFromText(r.view_cone, 0)
          FROM jsonb_to_recordset(${jsonb(bundle.framePoses)})
            AS r(storage_path text, camera_pose text, view_cone text)
          WHERE p.scan_id = ${scanId} AND p.storage_path = r.storage_path`);
      }
      await tx.execute(sql`
        INSERT INTO scan_layers (scan_id, user_id, level, name, producer, payload, quality)
        SELECT ${scanId}, ${userId}, r.level, r.name, r.producer, r.payload, r.quality
        FROM jsonb_to_recordset(${jsonb(bundle.layers)}) AS r(level smallint, name text,
          producer text, payload jsonb, quality numeric)`);

      // ---- privacy purge ----
      // Screening ran alongside reconstruction. Purging still happens only
      // after the reconstruction has reasoned over the frames.
      let notes: Record<string, unknown> = { ...previousNotes, ...bundle.analysisNotes };
      let purged = 0;
      if (bundle.privacyPaths.length) {
        const removed = await this.deletePhotos(tx, scanId, bundle.privacyPaths);
        purged = removed.length;
        if (removed.length) {
          notes = appendRemoval(notes, {
            at: new Date().toISOString(),
            reason: "people",
            source: "analysis",
            frames: removed.map(removedFrame),
          });
        }
      }
      notes["privacy_frames_removed"] = purged;

      const s = bundle.scan;
      await tx.execute(sql`
        UPDATE scans SET
          name = ${s.name},
          ai_summary = ${sanitizeText(s.summary, 4000) || null},
          width_m = ${s.width}, length_m = ${s.length}, height_m = ${s.height},
          floor_area_m2 = ${Math.round(s.width * s.length * 100) / 100},
          volume_m3 = ${Math.round(s.width * s.length * s.height * 100) / 100},
          footprint = ST_GeomFromText(${s.footprint}, 0),
          dimension_confidence = ${jsonb(s.dimensionConfidence)},
          scale_reference = ${s.scaleReference},
          analysis_notes = ${jsonb(notes)},
          lod_level = 5,
          status = 'ready',
          provider = ${s.provider},
          model_version = ${s.modelVersion},
          prompt_version = ${s.promptVersion}
        WHERE id = ${scanId}`);

      await this.closeRun(tx, run, {
        status: "succeeded",
        frames: bundle.frameCount,
        usage: bundle.usage,
        metrics: { ...bundle.metrics, privacy_frames_removed: purged, llm_usage: bundle.usage },
      });
      await tx.execute(sql`DELETE FROM analysis_checkpoints WHERE analysis_id = ${run.analysisId}`);
      return true;
    });
  }

  /**
   * Gives up on a run: the scan becomes `failed` with the error (so the space
   * page offers a retry) and the run is closed with its usage so far.
   */
  async failRun(
    run: RunRef,
    failure: { code: string; message: string; usage: UsageSummary | null },
  ): Promise<void> {
    const message = sanitizeText(failure.message, 500);
    await this.db.transaction(async (tx) => {
      if (await this.ownsScan(tx, run, true)) {
        await tx.execute(sql`
          UPDATE scans SET status = 'failed',
            analysis_notes = analysis_notes || ${jsonb({
              error: message,
              failed_at: new Date().toISOString(),
              stage: "failed",
            })}
          WHERE id = ${run.scanId}`);
      }
      await this.closeRun(tx, run, {
        status: "failed",
        errorCode: failure.code,
        errorMessage: message,
        usage: failure.usage,
        metrics: failure.usage ? { llm_usage: failure.usage } : {},
      });
    });
  }

  private async closeRun(
    tx: Transaction,
    run: RunRef,
    outcome: {
      status: "succeeded" | "failed";
      frames?: number;
      errorCode?: string;
      errorMessage?: string;
      usage: UsageSummary | null;
      metrics: Record<string, unknown>;
    },
  ) {
    await tx.execute(sql`
      UPDATE scan_analyses SET
        status = ${outcome.status},
        finished_at = now(),
        duration_ms = (extract(epoch FROM now() - started_at) * 1000)::int,
        input_frame_count = coalesce(${outcome.frames ?? null}::int, input_frame_count),
        input_token_estimate = ${outcome.usage?.input_tokens ?? null},
        output_token_estimate = ${outcome.usage?.output_tokens ?? null},
        cost_estimate_usd = ${outcome.usage?.estimated_cost_usd ?? null},
        error_code = ${outcome.errorCode ?? null},
        error_message = ${outcome.errorMessage ?? null},
        metrics = ${jsonb(outcome.metrics)}
      WHERE id = ${run.analysisId} AND status IN ('queued', 'running')`);
  }

  /**
   * Deletes frames by blob key and queues their files (and thumbnails) for
   * deletion. Returns the removed rows, for the removal record.
   */
  async deletePhotos(tx: Transaction, scanId: string, paths: string[]) {
    const { rows } = await tx.execute<{
      idx: number;
      heading_deg: string | null;
      sensor_payload: unknown;
      storage_path: string;
      thumbnail_path: string | null;
    }>(sql`
      DELETE FROM scan_photos
      WHERE scan_id = ${scanId} AND storage_path = ANY(${sql.param(paths)}::text[])
      RETURNING idx, heading_deg, sensor_payload, storage_path, thumbnail_path`);
    await enqueueOutbox(tx, {
      topic: OUTBOX_TOPICS.blobDelete,
      payload: {
        keys: rows
          .flatMap((r) => [r.storage_path, r.thumbnail_path])
          .filter((k): k is string => !!k),
      },
    });
    return rows;
  }
}

export interface PersistBundle {
  objects: ObjectRow[];
  surfaces: SurfaceRow[];
  portals: PortalRow[];
  navNodes: NavNodeRow[];
  navEdges: NavEdgeRow[];
  framePoses: FramePoseRow[];
  layers: Record<string, unknown>[];
  privacyPaths: string[];
  /** Keys merged into `scans.analysis_notes`. */
  analysisNotes: Record<string, unknown>;
  scan: {
    name: string;
    summary: string | null;
    width: number;
    length: number;
    height: number;
    footprint: string;
    dimensionConfidence: Record<string, unknown>;
    scaleReference: string;
    provider: string;
    modelVersion: string;
    promptVersion: string;
  };
  frameCount: number;
  usage: UsageSummary;
  metrics: Record<string, unknown>;
}
