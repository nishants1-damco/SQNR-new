// Per-user quotas on expensive or abusable actions (plan §11), backed by the
// consume_rate_limit() SQL function ported from the original app: one atomic
// upsert per call, so concurrent requests can't slip past the cap. Moves to
// Redis in phase 5.
//
// Fails closed: if the limiter can't decide, the request is refused (503).
import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
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
} as const satisfies Record<string, QuotaPolicy>;

@Injectable()
export class QuotaService {
  private readonly logger = new Logger("QuotaService");

  constructor(@Inject(DB) private readonly db: Database) {}

  async consume(userId: string, policy: QuotaPolicy): Promise<void> {
    let row: { allowed: boolean; retry_after_ms: string | number } | undefined;
    try {
      const result = await this.db.execute<{ allowed: boolean; retry_after_ms: string }>(
        sql`SELECT allowed, retry_after_ms FROM consume_rate_limit(${userId}, ${policy.bucket}, ${policy.windowMs}, ${policy.max})`,
      );
      row = result.rows[0];
    } catch (err) {
      this.logger.error({ err, bucket: policy.bucket }, "quota check failed; refusing request");
      throw ApiError.unavailable();
    }
    if (!row) throw ApiError.unavailable();
    if (!row.allowed) {
      throw ApiError.rateLimited(Math.max(1, Math.ceil(Number(row.retry_after_ms) / 1000)));
    }
  }
}

@Global()
@Module({ providers: [QuotaService], exports: [QuotaService] })
export class QuotaModule {}
