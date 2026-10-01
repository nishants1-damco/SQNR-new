// Guards on new analyses that aren't per-request quotas (plan §9.3, §9.7.6):
//   - daily AI spend caps, per user and across everyone. A run counts at its
//     recorded cost once it has finished, and at a configured estimate while
//     it is queued or running, including the run being asked for;
//   - backpressure: while too many runs are waiting for a worker, new ones get
//     503 with Retry-After instead of queueing behind hours of work.
// The global numbers are cached briefly per replica: they change slowly and
// every submit would otherwise sum the whole day's runs.
import { appMetrics } from "@spatial/observability";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { API_CONFIG } from "../config/config.module";
import { DB } from "../database/database.module";

const GLOBAL_CACHE_MS = 15_000;

interface Spend {
  spent: number;
  live: number;
}

@Injectable()
export class AnalysisLimits {
  private readonly logger = new Logger("AnalysisLimits");
  private global: { spend: Spend; queued: number; at: number } | null = null;
  private warnedAt = 0;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Throws when a new run would exceed a spend cap or the queue is full. */
  async check(userId: string): Promise<void> {
    const { budgets } = this.config.limits;
    const maxQueued = this.config.analysis.maxQueued;
    const needGlobal = budgets.globalDailyUsd > 0 || maxQueued > 0;
    const global = needGlobal ? await this.globalState() : null;

    if (global && maxQueued > 0 && global.queued >= maxQueued) {
      appMetrics().quotaRejections.add(1, { kind: "backpressure", bucket: "analysis" });
      throw new ApiError(
        503,
        "service_unavailable",
        "Lots of spaces are being analysed right now. Try again in a few minutes.",
        undefined,
        120,
      );
    }

    if (global && budgets.globalDailyUsd > 0) {
      const projected = this.projected(global.spend);
      if (projected > budgets.globalDailyUsd) {
        this.logger.error({ projected, cap: budgets.globalDailyUsd }, "global AI budget reached");
        appMetrics().quotaRejections.add(1, { kind: "budget", bucket: "global" });
        throw new ApiError(
          503,
          "service_unavailable",
          "Analysis is paused for today. Try again later.",
          undefined,
          3600,
        );
      }
      if (projected > budgets.globalDailyUsd * 0.8 && Date.now() - this.warnedAt > 10 * 60_000) {
        this.warnedAt = Date.now();
        this.logger.warn(
          { projected, cap: budgets.globalDailyUsd },
          "global AI spend passed 80% of today's budget",
        );
      }
    }

    if (budgets.perUserDailyUsd > 0) {
      const spend = await this.spend(sql`user_id = ${userId} AND`);
      if (this.projected(spend) > budgets.perUserDailyUsd) {
        appMetrics().quotaRejections.add(1, { kind: "budget", bucket: "user" });
        throw new ApiError(
          429,
          "rate_limited",
          "You've reached today's analysis budget. Try again tomorrow.",
          undefined,
          3600,
        );
      }
    }
  }

  /** Spend in the last 24 hours, counting live runs and the one being asked for at the estimate. */
  private projected(spend: Spend): number {
    return spend.spent + (spend.live + 1) * this.config.limits.budgets.runEstimateUsd;
  }

  private async spend(filter: ReturnType<typeof sql>): Promise<Spend> {
    const { rows } = await this.db.execute<{ spent: number; live: number }>(sql`
      SELECT
        coalesce(sum(cost_estimate_usd) FILTER (WHERE status NOT IN ('queued', 'running')), 0)::float8 AS spent,
        count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS live
      FROM scan_analyses
      WHERE ${filter} started_at > now() - interval '24 hours'`);
    return { spent: rows[0]?.spent ?? 0, live: rows[0]?.live ?? 0 };
  }

  private async globalState() {
    if (this.global && Date.now() - this.global.at < GLOBAL_CACHE_MS) return this.global;
    const [spend, queued] = await Promise.all([
      this.spend(sql``),
      this.db
        .execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM scan_analyses WHERE status = 'queued'`,
        )
        .then((r) => r.rows[0]?.n ?? 0),
    ]);
    this.global = { spend, queued, at: Date.now() };
    return this.global;
  }

  /** Forget the cached global numbers (tests). */
  reset() {
    this.global = null;
  }
}
