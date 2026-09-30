import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Database } from "@spatial/db";
import { sql } from "drizzle-orm";
import { ZodResponse } from "nestjs-zod";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { DB } from "../database/database.module";
import { QUOTAS, QuotaService } from "../quota/quota.service";
import { ScansRepository } from "../scans/scans.repository";
import {
  AddressDto,
  AddressResponseDto,
  GeocodeQueryDto,
  GeocodeResponseDto,
  ScanParamsDto,
} from "../scans/scans.dto";
import type { Geocoder } from "./geocoder";

export const GEOCODER = Symbol("GEOCODER");

@ApiTags("geocode")
@ApiBearerAuth()
@Controller()
export class GeocodeController {
  constructor(
    @Inject(GEOCODER) private readonly geocoder: Geocoder,
    @Inject(DB) private readonly db: Database,
    private readonly scans: ScansRepository,
    private readonly quota: QuotaService,
  ) {}

  /** Street address for a space's GPS fix, stored on the space (ported from resolveScanAddress). */
  @Post("scans/:id/address")
  @HttpCode(200)
  @ZodResponse({ status: 200, type: AddressResponseDto })
  async resolveAddress(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Body() body: AddressDto,
  ) {
    await this.scans.requireOwned(user.id, params.id);
    await this.quota.consume(user.id, QUOTAS.geocode);
    const result = await this.geocoder.reverse(body.lat, body.lon);
    const { rows } = await this.db.execute<{ site_address: string | null }>(
      sql`SELECT site_address FROM scans WHERE id = ${params.id} AND user_id = ${user.id}`,
    );
    const current = rows[0]?.site_address?.trim() || null;
    if (!result) return { address: current };
    // Indoors a fix often resolves only to a locality; that never replaces a real address.
    if (current && !result.precise) return { address: current };
    await this.db.execute(
      sql`UPDATE scans SET site_address = ${result.address} WHERE id = ${params.id} AND user_id = ${user.id}`,
    );
    return { address: result.address };
  }

  /** Coordinates for a typed address, so the map pin sits on the building. */
  @Get("geocode")
  @ZodResponse({ status: 200, type: GeocodeResponseDto })
  async forward(@CurrentUser() user: AuthUser, @Query() query: GeocodeQueryDto) {
    await this.quota.consume(user.id, QUOTAS.geocode);
    return { result: await this.geocoder.forward(query.address) };
  }
}
