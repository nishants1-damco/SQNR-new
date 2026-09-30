// Queueing and following analysis runs (plan §9, Appendix A). Replaces the
// `analyzeScan` server function, which ran the whole pipeline inside the
// request, and `purgePeopleFrames`.
//
// Starting a run is: the idempotency and status gate (`ensureAnalyzable` in
// the original's scan-service.ts), the quota, then one transaction that
// claims the scan, records the run and writes the job to the outbox. The
// claim can't be won twice: the scan row is locked, and a unique index
// allows one live run per scan.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type {
  AnalysisProvider,
  AnalysisStatusResponse,
  PrivacyPurgeResponse,
  StartAnalysisRequest,
  StartAnalysisResponse,
} from "@spatial/contracts";
import { type Database, enqueueOutbox, OUTBOX_TOPICS } from "@spatial/db";
import {
  analysisDeadlineFor,
  analysisDeadlineMs,
  isAnalysisStale,
} from "@spatial/domain/analysis-deadline";
import { PROMPT_VERSION } from "@spatial/domain/prompt-version";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { API_CONFIG } from "../config/config.module";
import { DB } from "../database/database.module";
import { QUOTAS, QuotaService } from "../quota/quota.service";

interface ScanState {
  [column: string]: unknown;
  id: string;
  status: string;
  analysis_notes: Record<string, unknown>;
  created_at: string;
  capture_id: string | null;
  provider: string | null;
  model_version: string | null;
  photos: number;
}

/** A sweep asked for this recently is still in the queue: don't queue another. */
const PURGE_PENDING_MS = 30 * 60 * 1000;

@Injectable()
export class AnalysisService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly quota: QuotaService,
  ) {}

  private async scanState(
    userId: string,
    scanId: string,
    executor: Pick<Database, "execute"> = this.db,
    lock = false,
  ): Promise<ScanState> {
    const { rows } = await executor.execute<ScanState>(sql`
      SELECT id, status, analysis_notes, capture_id, provider, model_version,
        to_jsonb(created_at) #>> '{}' AS created_at,
        (SELECT count(*)::int FROM scan_photos p WHERE p.scan_id = s.id) AS photos
      FROM scans s WHERE id = ${scanId} AND user_id = ${userId}
      ${lock ? sql`FOR UPDATE` : sql``}`);
    const scan = rows[0];
    if (!scan) throw ApiError.notFound("Space not found");
    return scan;
  }

  private providerFor(requested: AnalysisProvider | undefined): AnalysisProvider {
    const provider = requested ?? this.config.analysis.defaultProvider;
    if (provider === "ollama" && !this.config.analysis.localEnabled) {
      throw new ApiError(
        400,
        "invalid_request",
        "Local models are not available in this environment",
      );
    }
    return provider;
  }

  async start(
    userId: string,
    scanId: string,
    body: StartAnalysisRequest,
  ): Promise<{ status: 200 | 202; body: StartAnalysisResponse }> {
    const provider = this.providerFor(body.provider);
    const model = this.config.analysis.models[provider];
    const scan = await this.scanState(userId, scanId);

    // Idempotency + status gate. A duplicate submission with the same
    // capture id short-circuits to the existing scan; a scan that's already
    // processing within its deadline is left alone.
    if (body.captureId) {
      const { rows } = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM scans WHERE user_id = ${userId} AND capture_id = ${body.captureId}`);
      const dupe = rows[0];
      if (dupe && dupe.id !== scanId) return this.duplicate(dupe.id);
    }
    if (scan.status === "processing" && !isAnalysisStale(scan)) return this.running(scan);
    if (scan.photos === 0) throw ApiError.conflict("Upload frames before analysing this space");

    // Only runs that will actually happen are charged.
    await this.quota.consume(userId, QUOTAS.analyzeScanHourly);
    await this.quota.consume(userId, QUOTAS.analyzeScanDaily);

    const analysisId = randomUUID();
    const topic = provider === "ollama" ? OUTBOX_TOPICS.analysisLocal : OUTBOX_TOPICS.analysisCloud;
    try {
      const claimed = await this.db.transaction(async (tx) => {
        const current = await this.scanState(userId, scanId, tx, true);
        if (current.status === "processing" && !isAnalysisStale(current)) return current;
        // Re-running an abandoned run: close its record first.
        await tx.execute(sql`
          UPDATE scan_analyses SET status = 'timed_out', finished_at = now(),
            error_code = 'timed_out', error_message = 'Superseded by a new run after its deadline'
          WHERE scan_id = ${scanId} AND status IN ('queued', 'running')`);
        await tx.execute(sql`
          INSERT INTO scan_analyses (id, scan_id, user_id, provider, model_version, prompt_version, status)
          VALUES (${analysisId}, ${scanId}, ${userId}, ${provider}, ${model}, ${PROMPT_VERSION}, 'queued')`);
        const startedAt = new Date();
        await tx.execute(sql`
          UPDATE scans SET
            status = 'processing',
            capture_id = coalesce(${body.captureId ?? null}::uuid, capture_id),
            provider = ${provider},
            model_version = ${model},
            prompt_version = ${PROMPT_VERSION},
            analysis_notes = analysis_notes || ${JSON.stringify({
              analysis_id: analysisId,
              started_at: startedAt.toISOString(),
              deadline_at: analysisDeadlineFor(provider, startedAt.getTime()),
              failed_at: null,
              error: null,
              swept: null,
              stage: "queued",
              progress_pct: 0,
            })}::jsonb
          WHERE id = ${scanId}`);
        await enqueueOutbox(tx, {
          topic,
          payload: { analysisId, scanId, userId, provider, model },
        });
        return null;
      });
      if (claimed) return this.running(claimed);
    } catch (err) {
      // Another request claimed it between our read and our lock, or the
      // capture id was taken by another scan in the meantime.
      if ((err as { code?: string }).code === "23505") {
        const again = await this.scanState(userId, scanId);
        if (again.status === "processing") return this.running(again);
        throw ApiError.conflict("This capture was already submitted for another space");
      }
      throw err;
    }
    return {
      status: 202,
      body: { outcome: "queued", scanId, analysisId, provider, model },
    };
  }

  private duplicate(scanId: string): { status: 200; body: StartAnalysisResponse } {
    return {
      status: 200 as const,
      body: {
        outcome: "duplicate" as const,
        scanId,
        analysisId: null,
        provider: null,
        model: null,
      },
    };
  }

  private running(scan: ScanState): { status: 200; body: StartAnalysisResponse } {
    const notes = scan.analysis_notes ?? {};
    const analysisId = typeof notes["analysis_id"] === "string" ? notes["analysis_id"] : null;
    return {
      status: 200 as const,
      body: {
        outcome: "already_running" as const,
        scanId: scan.id,
        analysisId,
        provider:
          scan.provider === "claude" || scan.provider === "ollama"
            ? (scan.provider as AnalysisProvider)
            : null,
        model: scan.model_version,
      },
    };
  }

  async status(userId: string, scanId: string): Promise<AnalysisStatusResponse> {
    const scan = await this.scanState(userId, scanId);
    const notes = scan.analysis_notes ?? {};
    const { rows } = await this.db.execute<{
      [column: string]: unknown;
      id: string;
      status: "queued" | "running" | "succeeded" | "failed" | "timed_out";
      provider: string;
      model_version: string;
      prompt_version: string;
      attempts: number;
      started_at: string;
      finished_at: string | null;
      duration_ms: number | null;
      cost: number | null;
      error_code: string | null;
    }>(sql`
      SELECT id, status, provider, model_version, prompt_version, attempts,
        to_jsonb(started_at) #>> '{}' AS started_at, to_jsonb(finished_at) #>> '{}' AS finished_at,
        duration_ms, cost_estimate_usd::float8 AS cost, error_code
      FROM scan_analyses WHERE scan_id = ${scanId}
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    const run = rows[0];
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const deadline =
      scan.status === "processing" ? analysisDeadlineMs(notes, scan.created_at) : null;
    return {
      scanId,
      scanStatus: scan.status as AnalysisStatusResponse["scanStatus"],
      stage: str(notes["stage"]),
      progressPct: typeof notes["progress_pct"] === "number" ? notes["progress_pct"] : null,
      deadlineAt: deadline ? new Date(deadline).toISOString() : null,
      error: scan.status === "failed" ? str(notes["error"]) : null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            provider: run.provider,
            model: run.model_version,
            promptVersion: run.prompt_version,
            attempts: run.attempts,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            durationMs: run.duration_ms,
            costEstimateUsd: run.cost,
            errorCode: run.error_code,
          }
        : null,
    };
  }

  /** Queues a sweep of every frame for people (the original `purgePeopleFrames`). */
  async requestPrivacyPurge(userId: string, scanId: string): Promise<PrivacyPurgeResponse> {
    const scan = await this.scanState(userId, scanId);
    const pending = scan.analysis_notes?.["privacy_sweep"] as
      { status?: string; requested_at?: string } | undefined;
    if (
      pending?.status === "queued" &&
      pending.requested_at &&
      Date.now() - Date.parse(pending.requested_at) < PURGE_PENDING_MS
    ) {
      return { status: "queued", requestedAt: pending.requested_at };
    }
    // Each sweep re-screens every frame through the model, so cap it per user.
    await this.quota.consume(userId, QUOTAS.purgePeople);
    const requestedAt = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE scans SET analysis_notes = analysis_notes || ${JSON.stringify({
          privacy_sweep: { status: "queued", requested_at: requestedAt },
        })}::jsonb
        WHERE id = ${scanId} AND user_id = ${userId}`);
      await enqueueOutbox(tx, {
        topic: OUTBOX_TOPICS.privacyPurge,
        payload: { scanId, userId, requestedAt },
      });
    });
    return { status: "queued", requestedAt };
  }
}
