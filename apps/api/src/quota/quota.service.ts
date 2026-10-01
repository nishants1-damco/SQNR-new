// Per-user quotas on expensive or abusable actions (plan §11). Counted in
// Redis (GCRA, see common/rate-limiter.ts) since phase 5. The original
// consume_rate_limit() SQL function is kept behind QUOTA_BACKEND=postgres, so
// the two can be compared and the database can take over if Redis can't.
//
// Fails closed: if the limiter can't decide, the request is refused (503).
import { appMetrics } from "@spatial/observability";
import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { RateLimiter } from "../common/rate-limiter";
import { API_CONFIG } from "../config/config.module";
import { DB } from "../database/database.module";

export interface QuotaPolicy {
  bucket: string;
  windowMs: number;
  max: number;
}

const HOUR = 60 * 60 * 1000;

export const QUOTAS = {
  /** Each session signs up to 200 upload URLs. */
  uploadSession: { bucket: "upload_session", windowMs: HOUR, max: 120 },
  /** Geocoding calls a third-party service with its own usage policy. */
  geocode: { bucket: "geocode", windowMs: HOUR, max: 60 },
  /**
   * At roughly $5 of Claude Opus 5.5 per scan, the original 30 an hour let one
   * account spend ~$150 an hour (plan §9.7.6): 5 an hour and 20 a day.
   */
  analyzeScanHourly: { bucket: "analyze_scan", windowMs: HOUR, max: 5 },
  analyzeScanDaily: { bucket: "analyze_scan_day", windowMs: 24 * HOUR, max: 20 },
  /** One frame set re-screened per sweep, about $0.60. */
  purgePeople: { bucket: "purge_people", windowMs: HOUR, max: 10 },
} as const satisfies Record<string, QuotaPolicy>;

@Injectable()
export class QuotaService {
  private readonly logger = new Logger("QuotaService");

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly limiter: RateLimiter,
  ) {}

  async consume(userId: string, policy: QuotaPolicy): Promise<void> {
    let decision: { allowed: boolean; retryAfterMs: number };
    try {
      decision =
        this.config.limits.quotaBackend === "postgres"
          ? await this.consumeInPostgres(userId, policy)
          : await this.limiter.hit(`quota:${policy.bucket}:${userId}`, {
              max: policy.max,
              windowMs: policy.windowMs,
            });
    } catch (err) {
      this.logger.error({ err, bucket: policy.bucket }, "quota check failed; refusing request");
      throw ApiError.unavailable();
    }
    if (!decision.allowed) {
      appMetrics().quotaRejections.add(1, { kind: "quota", bucket: policy.bucket });
      throw ApiError.rateLimited(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
  }

  private async consumeInPostgres(userId: string, policy: QuotaPolicy) {
    const { rows } = await this.db.execute<{ allowed: boolean; retry_after_ms: string }>(
      sql`SELECT allowed, retry_after_ms FROM consume_rate_limit(${userId}, ${policy.bucket}, ${policy.windowMs}, ${policy.max})`,
    );
    const row = rows[0];
    if (!row) throw new Error("consume_rate_limit returned nothing");
    return { allowed: row.allowed, retryAfterMs: Number(row.retry_after_ms) };
  }
}

@Global()
@Module({
  providers: [QuotaService, RateLimiter],
  exports: [QuotaService, RateLimiter],
})
export class QuotaModule {}
