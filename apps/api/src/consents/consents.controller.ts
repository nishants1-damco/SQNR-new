import { Body, Controller, Inject, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { DB } from "../database/database.module";
import { ConsentDto, ConsentResponseDto } from "../scans/scans.dto";

/**
 * Durable record that the user accepted the capture consent gate (ported from
 * recordCaptureConsent). Idempotent per capture session.
 */
@ApiTags("consents")
@ApiBearerAuth()
@Controller("consents")
export class ConsentsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Post()
  @ZodResponse({ status: 201, type: ConsentResponseDto })
  async record(@CurrentUser() user: AuthUser, @Body() body: ConsentDto) {
    await this.db.execute(sql`
      INSERT INTO capture_consents (user_id, capture_id, consent_version, user_agent)
      VALUES (${user.id}, ${body.captureId}, ${body.consentVersion}, ${body.userAgent ?? null})
      ON CONFLICT (user_id, capture_id) DO NOTHING`);
    return { ok: true as const };
  }
}
