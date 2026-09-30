// Every scan query, always scoped to the caller (plan §7.4, §10.3): each
// method takes the user id and puts it in the WHERE clause, and a row that
// isn't the caller's is indistinguishable from one that doesn't exist.
//
// Rows are rendered by Postgres with to_jsonb(), which gives the same JSON the
// original app received from Supabase: numerics as numbers, timestamps as ISO
// strings, geometry as GeoJSON. site_location (geography) is converted
// explicitly because it has no JSON cast of its own.
import { Inject, Injectable } from "@nestjs/common";
import type { ScanListItem, ScanListQuery, ScanRecord } from "@spatial/contracts";
import type { Database, Transaction } from "@spatial/db";
import { type SQL, sql } from "drizzle-orm";
import { ApiError } from "../common/api-error";
import { DB } from "../database/database.module";

type Executor = Database | Transaction;
type Row = Record<string, unknown>;

export interface OwnedScan {
  [column: string]: unknown;
  id: string;
  status: string;
  analysis_notes: Record<string, unknown>;
  created_at: string;
  depth_path: string | null;
}

export interface ListRow extends Omit<ScanListItem, "thumbnail_url"> {
  [column: string]: unknown;
  thumbnail_key: string | null;
  cursor_value: string;
}

const SCAN_JSON = sql`to_jsonb(s) || jsonb_build_object('site_location', ST_AsGeoJSON(s.site_location)::jsonb)`;

/** `%`/`_` in a user's search are literal characters, not wildcards. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Keyset pagination per sort: `key` is compared with the last row's value
 * (cast to `type`) and id, so pages never skip or repeat rows. Timestamps
 * travel as text to keep Postgres's microsecond precision.
 */
const SORTS: Record<
  ScanListQuery["sort"],
  { key: SQL; cursor: SQL; type: string; order: SQL; after: "<" | ">" }
> = {
  newest: {
    key: sql`s.created_at`,
    cursor: sql`s.created_at::text`,
    type: "timestamptz",
    order: sql`s.created_at DESC, s.id DESC`,
    after: "<",
  },
  oldest: {
    key: sql`s.created_at`,
    cursor: sql`s.created_at::text`,
    type: "timestamptz",
    order: sql`s.created_at ASC, s.id ASC`,
    after: ">",
  },
  name: {
    key: sql`lower(s.name)`,
    cursor: sql`lower(s.name)`,
    type: "text",
    order: sql`lower(s.name) ASC, s.id ASC`,
    after: ">",
  },
  area: {
    key: sql`coalesce(s.floor_area_m2, -1)`,
    cursor: sql`coalesce(s.floor_area_m2, -1)::text`,
    type: "numeric",
    order: sql`coalesce(s.floor_area_m2, -1) DESC, s.id DESC`,
    after: "<",
  },
};

@Injectable()
export class ScansRepository {
  constructor(@Inject(DB) readonly db: Database) {}

  /** The caller's scan, or 404. `forUpdate` locks it for the rest of the transaction. */
  async requireOwned(
    userId: string,
    scanId: string,
    executor: Executor = this.db,
    forUpdate = false,
  ): Promise<OwnedScan> {
    const { rows } = await executor.execute<OwnedScan>(sql`
      SELECT id, status, analysis_notes, to_jsonb(created_at) #>> '{}' AS created_at, depth_path
      FROM scans WHERE id = ${scanId} AND user_id = ${userId}
      ${forUpdate ? sql`FOR UPDATE` : sql``}`);
    const scan = rows[0];
    if (!scan) throw ApiError.notFound("Space not found");
    return scan;
  }

  async list(
    userId: string,
    query: ScanListQuery,
    after: { value: string | number; id: string } | null,
  ): Promise<ListRow[]> {
    const sort = SORTS[query.sort];
    const where: SQL[] = [sql`s.user_id = ${userId}`];
    if (query.status) where.push(sql`s.status = ${query.status}`);
    if (query.q) {
      const pattern = likePattern(query.q);
      where.push(
        sql`(s.name ILIKE ${pattern} OR s.ai_summary ILIKE ${pattern} OR s.site_address ILIKE ${pattern})`,
      );
    }
    if (after) {
      where.push(
        sql`(${sort.key}, s.id) ${sql.raw(sort.after)} (${String(after.value)}::${sql.raw(sort.type)}, ${after.id}::uuid)`,
      );
    }
    const { rows } = await this.db.execute<ListRow>(sql`
      SELECT s.id, s.name, s.status,
        s.width_m::float8 AS width_m, s.length_m::float8 AS length_m, s.height_m::float8 AS height_m,
        s.floor_area_m2::float8 AS floor_area_m2, s.site_address, s.ai_summary,
        CASE WHEN jsonb_typeof(s.acoustics->'rt60_s') = 'number'
             THEN (s.acoustics->>'rt60_s')::float8 END AS rt60_s,
        to_jsonb(s.created_at) #>> '{}' AS created_at,
        (SELECT count(*)::int FROM scan_objects o WHERE o.scan_id = s.id) AS object_count,
        (SELECT count(*)::int FROM scan_portals p WHERE p.scan_id = s.id) AS portal_count,
        (SELECT coalesce(ph.thumbnail_path, ph.storage_path) FROM scan_photos ph
          WHERE ph.scan_id = s.id ORDER BY ph.idx, ph.id LIMIT 1) AS thumbnail_key,
        ${sort.cursor} AS cursor_value
      FROM scans s
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY ${sort.order}
      LIMIT ${query.limit + 1}`);
    return rows;
  }

  async totals(userId: string): Promise<{ count: number; floorAreaM2: number }> {
    const { rows } = await this.db.execute<{ count: number; area: number }>(sql`
      SELECT count(*)::int AS count, coalesce(sum(floor_area_m2), 0)::float8 AS area
      FROM scans WHERE user_id = ${userId}`);
    return { count: rows[0]?.count ?? 0, floorAreaM2: rows[0]?.area ?? 0 };
  }

  async scanJson(
    userId: string,
    scanId: string,
    executor: Executor = this.db,
  ): Promise<ScanRecord> {
    const { rows } = await executor.execute<{ scan: ScanRecord }>(
      sql`SELECT ${SCAN_JSON} AS scan FROM scans s WHERE s.id = ${scanId} AND s.user_id = ${userId}`,
    );
    const scan = rows[0]?.scan;
    if (!scan) throw ApiError.notFound("Space not found");
    return scan;
  }

  /** Child rows for the detail view. Only call after requireOwned/scanJson. */
  async children(scanId: string) {
    const rowsOf = async (table: SQL, order: SQL) =>
      (
        await this.db.execute<{ row: Row }>(
          sql`SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.scan_id = ${scanId} ORDER BY ${order}`,
        )
      ).rows.map((r) => r.row);
    const [objects, portals, surfaces, photos] = await Promise.all([
      rowsOf(sql`scan_objects`, sql`t.created_at, t.id`),
      rowsOf(sql`scan_portals`, sql`t.created_at, t.id`),
      rowsOf(sql`scan_surfaces`, sql`t.created_at, t.id`),
      rowsOf(sql`scan_photos`, sql`t.idx, t.id`),
    ]);
    return { objects, portals, surfaces, photos };
  }

  /** Inserts a scan; with a capture id already used by this user, returns that scan instead. */
  async create(
    userId: string,
    values: {
      captureId: string | null;
      name: string;
      notes: string | null;
      acoustics: Row;
      analysisNotes: Row;
      site: { lat: number; lon: number } | null;
      depthProvided: boolean;
      depthMetrics: Row;
      scaleReference: string | null;
      depthSource: string | null;
    },
  ): Promise<{ id: string; created: boolean }> {
    const site = values.site
      ? sql`ST_SetSRID(ST_MakePoint(${values.site.lon}, ${values.site.lat}), 4326)::geography`
      : sql`NULL`;
    const { rows } = await this.db.execute<{ id: string }>(sql`
      INSERT INTO scans (user_id, capture_id, name, notes, status, acoustics, analysis_notes,
        site_location, depth_provided, depth_metrics, scale_reference, depth_source)
      VALUES (${userId}, ${values.captureId}, ${values.name}, ${values.notes}, 'draft',
        ${JSON.stringify(values.acoustics)}::jsonb, ${JSON.stringify(values.analysisNotes)}::jsonb,
        ${site}, ${values.depthProvided}, ${JSON.stringify(values.depthMetrics)}::jsonb,
        ${values.scaleReference}, ${values.depthSource})
      ON CONFLICT (user_id, capture_id) WHERE capture_id IS NOT NULL DO NOTHING
      RETURNING id`);
    if (rows[0]) return { id: rows[0].id, created: true };
    const existing = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM scans WHERE user_id = ${userId} AND capture_id = ${values.captureId}`,
    );
    if (!existing.rows[0]) throw new Error("scan insert conflicted but no scan found");
    return { id: existing.rows[0].id, created: false };
  }

  async update(
    userId: string,
    scanId: string,
    patch: { name?: string; notes?: string | null; analysisNotes?: Row },
  ): Promise<void> {
    const sets: SQL[] = [];
    if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
    if (patch.notes !== undefined) sets.push(sql`notes = ${patch.notes}`);
    if (patch.analysisNotes !== undefined) {
      // Shallow merge: capture-owned keys replace, server-written keys stay.
      sets.push(
        sql`analysis_notes = analysis_notes || ${JSON.stringify(patch.analysisNotes)}::jsonb`,
      );
    }
    const { rowCount } = await this.db.execute(
      sql`UPDATE scans SET ${sql.join(sets, sql`, `)} WHERE id = ${scanId} AND user_id = ${userId}`,
    );
    if (!rowCount) throw ApiError.notFound("Space not found");
  }

  /** Every blob key a scan's rows reference (frames, thumbnails, depth file). */
  async blobKeys(scanId: string, executor: Executor = this.db): Promise<string[]> {
    const { rows } = await executor.execute<{ key: string }>(sql`
      SELECT storage_path AS key FROM scan_photos WHERE scan_id = ${scanId}
      UNION SELECT thumbnail_path FROM scan_photos WHERE scan_id = ${scanId} AND thumbnail_path IS NOT NULL
      UNION SELECT depth_path FROM scans WHERE id = ${scanId} AND depth_path IS NOT NULL`);
    return rows.map((r) => r.key);
  }

  /** The subset of `keys` that belong to the caller's own scans. */
  async ownedBlobKeys(userId: string, keys: string[]): Promise<Set<string>> {
    const { rows } = await this.db.execute<{ key: string }>(sql`
      SELECT storage_path AS key FROM scan_photos
        WHERE user_id = ${userId} AND storage_path = ANY(${sql.param(keys)}::text[])
      UNION SELECT thumbnail_path FROM scan_photos
        WHERE user_id = ${userId} AND thumbnail_path = ANY(${sql.param(keys)}::text[])
      UNION SELECT depth_path FROM scans
        WHERE user_id = ${userId} AND depth_path = ANY(${sql.param(keys)}::text[])`);
    return new Set(rows.map((r) => r.key));
  }
}
