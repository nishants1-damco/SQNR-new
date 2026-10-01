// The full spatial record for a space (ported from exportScanData): a GeoJSON
// FeatureCollection, the raw PostGIS rows with WKT geometry, the
// self-describing L0–L5 layer bundle, an IMDF archive and an OpenUSD scene.
// `?format=` returns just one of them.
import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { buildImdf, type Json } from "@spatial/domain/imdf";
import { SPATIAL_ONTOLOGY } from "@spatial/domain/scan-spatial";
import { buildUsd } from "@spatial/domain/usd";
import { sql } from "drizzle-orm";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { ApiError } from "../common/api-error";
import { ReadRouter } from "../database/database.module";
import { ExportQueryDto, ScanParamsDto } from "../scans/scans.dto";

interface RawExport {
  geojson: { [key: string]: Json };
  postgis: { [key: string]: Json };
  layers: Json[];
}

@ApiTags("scans")
@ApiBearerAuth()
@Controller("scans/:id/export")
export class ExportsController {
  constructor(private readonly reads: ReadRouter) {}

  @Get()
  async export(
    @CurrentUser() user: AuthUser,
    @Param() params: ScanParamsDto,
    @Query() query: ExportQueryDto,
  ) {
    const db = await this.reads.forUser(user.id);
    const { rows } = await db.execute<{ bundle: RawExport | null }>(
      sql`SELECT scan_export(${params.id}, ${user.id}) AS bundle`,
    );
    const raw = rows[0]?.bundle;
    if (!raw) throw ApiError.notFound("Space not found");

    const layerRows = Array.isArray(raw.layers) ? raw.layers : [];
    const scanRow = ((raw.postgis?.["scans"] as Record<string, Json>[] | undefined) ?? [])[0] ?? {};
    const parts = {
      geojson: () => raw.geojson,
      postgis: () => raw.postgis,
      layers: () => ({
        ontology: SPATIAL_ONTOLOGY as unknown as Json,
        crs: { local: "room-centred metric (X east, Y north, Z up), SRID 0", site: "EPSG:4326" },
        scan_id: params.id,
        room_name: scanRow["name"] == null ? null : String(scanRow["name"]),
        generated_at: new Date().toISOString(),
        level_count: layerRows.length,
        layers: layerRows,
      }),
      // IMDF and USD read the raw rows, before the layer array is wrapped.
      imdf: () => buildImdf(raw),
      usd: () => buildUsd(raw),
    };
    if (query.format !== "all") return parts[query.format]();
    return {
      geojson: parts.geojson(),
      postgis: parts.postgis(),
      layers: parts.layers(),
      imdf: parts.imdf(),
      usd: parts.usd(),
    };
  }
}
