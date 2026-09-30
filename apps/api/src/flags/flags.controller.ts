// Feature flags (ported from feature-flags.ts): a per-user row overrides the
// global row (user_id NULL); unknown keys are off. Resolved flags are cached
// per user for a minute, so a UI that asks often doesn't reach the database.
import { Controller, Get, Inject } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { DB } from "../database/database.module";
import { FlagsResponseDto } from "../scans/scans.dto";

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_USERS = 10_000;

@ApiTags("flags")
@ApiBearerAuth()
@Controller("flags")
export class FlagsController {
  private readonly cache = new Map<string, { flags: Record<string, boolean>; expiresAt: number }>();

  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  @ZodResponse({ status: 200, type: FlagsResponseDto })
  async flags(@CurrentUser() user: AuthUser) {
    const cached = this.cache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) return { flags: cached.flags };

    const { rows } = await this.db.execute<{
      key: string;
      user_id: string | null;
      enabled: boolean;
    }>(
      sql`SELECT key, user_id, enabled FROM feature_flags WHERE user_id IS NULL OR user_id = ${user.id}`,
    );
    const flags: Record<string, boolean> = {};
    for (const row of rows) if (row.user_id === null) flags[row.key] = row.enabled;
    for (const row of rows) if (row.user_id !== null) flags[row.key] = row.enabled;

    if (this.cache.size >= CACHE_MAX_USERS) this.cache.clear();
    this.cache.set(user.id, { flags, expiresAt: Date.now() + CACHE_TTL_MS });
    return { flags };
  }
}
