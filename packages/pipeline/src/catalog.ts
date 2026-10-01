// Product catalog I/O, the half of `src/lib/product-catalog.ts` that talks to
// the database, the embedding backend and the network. The matching logic
// itself is pure and lives in @spatial/domain/product-catalog.
//
// Everything here is an enhancement to the analysis: a failure logs and
// returns "no match", never an error.
import type { Database } from "@spatial/db";
import {
  type CatalogMatch,
  catalogImageUrl,
  pickProductMatch,
  type ProductDimension,
} from "@spatial/domain/product-catalog";
import { sql } from "drizzle-orm";
import { errString, type PipelineLogger } from "./logger";

export interface Embedder {
  /** The raw 768-dim vector, or null on any failure. Never throws. */
  embed(text: string): Promise<number[] | null>;
}

export interface EmbedderSettings {
  provider: "gemini" | "ollama" | "none";
  model: string;
  /** Gemini API key (gemini only). */
  apiKey?: string | null;
  /** OpenAI-compatible base URL (ollama only), e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl?: string | null;
}

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";

/**
 * The embedding backend is independent of the generation provider: Claude has
 * no embeddings API, so the catalog index runs on Gemini in the cloud or
 * Ollama locally. Both expose an OpenAI-compatible `/embeddings` endpoint.
 * Vectors must be 768-dim to match the `vector(768)` column.
 */
export function createEmbedder(settings: EmbedderSettings, fetchImpl = fetch): Embedder | null {
  if (settings.provider === "none") return null;
  if (settings.provider === "gemini" && !settings.apiKey) return null;
  const url =
    settings.provider === "ollama"
      ? `${(settings.baseUrl ?? "").replace(/\/$/, "")}/embeddings`
      : GEMINI_EMBED_URL;
  return {
    async embed(text) {
      const input = text.trim();
      if (!input) return null;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (settings.provider === "gemini") headers["Authorization"] = `Bearer ${settings.apiKey}`;
        // Gemini's embedding models are natively larger; the OpenAI-compatible
        // `dimensions` parameter truncates server-side. Ollama's 768-dim models
        // don't accept it.
        const body: Record<string, unknown> = { model: settings.model, input };
        if (settings.provider === "gemini") body["dimensions"] = 768;
        const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: { embedding?: unknown }[] };
        const vec = json.data?.[0]?.embedding;
        return Array.isArray(vec) && vec.every((n) => typeof n === "number")
          ? (vec as number[])
          : null;
      } catch {
        return null;
      }
    },
  };
}

export interface CatalogSourceOptions {
  db: Database;
  embedder: Embedder | null;
  logger: PipelineLogger;
  /**
   * Origins catalog reference photos may be downloaded from (SSRF guard).
   * Empty means none: the analysis then compares products by name and specs.
   */
  imageOrigins: string[];
  fetch?: typeof fetch;
}

type Row = Record<string, unknown>;

const toNumber = (v: unknown) => (v == null ? null : Number(v));

function toDimension(row: Row): ProductDimension {
  return {
    id: String(row["id"]),
    category: String(row["category"]),
    label: String(row["label"]),
    brand: (row["brand"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    width_m: toNumber(row["width_m"]),
    height_m: toNumber(row["height_m"]),
    depth_m: toNumber(row["depth_m"]),
    diagonal_in: toNumber(row["diagonal_in"]),
    aspect_ratio: (row["aspect_ratio"] as string | null) ?? null,
  };
}

function toMatch(row: Row): CatalogMatch {
  return {
    ...toDimension(row),
    classification: (row["classification"] as string | null) ?? null,
    image_url: (row["image_url"] as string | null) ?? null,
    specs: (row["specs"] as Record<string, unknown> | null) ?? null,
    similarity: Number(row["similarity"] ?? 0),
  };
}

/** How long a category's catalog rows are reused before being read again. */
const SLICE_TTL_MS = 10 * 60 * 1000;

export class CatalogSource {
  /**
   * Category slices are small (<100 rows) and change rarely; the worker keeps
   * one CatalogSource for the process, so they expire rather than live forever.
   */
  private readonly slices = new Map<string, { rows: Promise<ProductDimension[]>; at: number }>();

  constructor(private readonly options: CatalogSourceOptions) {}

  private get db() {
    return this.options.db;
  }

  /**
   * The best catalog row for a label like "55-inch OLED TV" or "bathroom door",
   * or null when nothing plausibly fits or the match is ambiguous.
   */
  async matchProduct(category: string, label: string): Promise<ProductDimension | null> {
    try {
      let slice = this.slices.get(category);
      if (!slice || Date.now() - slice.at > SLICE_TTL_MS) {
        slice = {
          rows: this.db
            .execute<Row>(
              sql`SELECT id, category, label, brand, model, width_m, height_m, depth_m, diagonal_in, aspect_ratio
                FROM product_dimensions WHERE category = ${category} ORDER BY label`,
            )
            .then((r) => r.rows.map(toDimension)),
          at: Date.now(),
        };
        this.slices.set(category, slice);
      }
      return pickProductMatch(await slice.rows, category, label);
    } catch (err) {
      this.slices.delete(category);
      this.options.logger.warn({ category, err: errString(err) }, "matchProduct failed");
      return null;
    }
  }

  /**
   * Embed each query string and pull the top matches from the catalog vector
   * index, merged and de-duplicated by product, keeping only entries above a
   * similarity floor. Returns [] whenever embeddings or the index are
   * unavailable.
   */
  async retrieveCatalogMatches(
    queries: string[],
    opts: { perQuery?: number; minSimilarity?: number; maxTotal?: number } = {},
  ): Promise<CatalogMatch[]> {
    const embedder = this.options.embedder;
    if (!embedder) return [];
    const perQuery = opts.perQuery ?? 3;
    const minSimilarity = opts.minSimilarity ?? 0.35;
    const maxTotal = opts.maxTotal ?? 8;
    const uniqueQueries = [
      ...new Set(queries.map((q) => q.trim().toLowerCase()).filter(Boolean)),
    ].slice(0, 8);
    if (uniqueQueries.length === 0) return [];

    const best = new Map<string, CatalogMatch>();
    for (const query of uniqueQueries) {
      const vector = await embedder.embed(query);
      if (!vector) continue;
      try {
        const { rows } = await this.db.execute<Row>(
          sql`SELECT * FROM match_product_catalog(${JSON.stringify(vector)}::vector, ${perQuery})`,
        );
        for (const row of rows.map(toMatch)) {
          if (row.similarity < minSimilarity) continue;
          const held = best.get(row.id);
          if (!held || row.similarity > held.similarity) best.set(row.id, row);
        }
      } catch (err) {
        this.options.logger.warn({ err: errString(err) }, "match_product_catalog failed");
      }
    }
    return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, maxTotal);
  }

  /**
   * Specific products (with a brand or model) in the given catalog categories:
   * candidates for visual matching even when text retrieval found nothing.
   */
  async loadBrandedProducts(categories: string[]): Promise<CatalogMatch[]> {
    if (categories.length === 0) return [];
    try {
      const { rows } = await this.db.execute<Row>(sql`
        SELECT id, category, label, brand, model, classification, image_url, specs,
               width_m, height_m, depth_m, diagonal_in, aspect_ratio
        FROM product_dimensions
        WHERE category = ANY(${sql.param(categories)}::text[])
          AND (brand IS NOT NULL OR model IS NOT NULL)
        ORDER BY label
        LIMIT 50`);
      return rows.map((row) => ({ ...toMatch(row), similarity: 0 }));
    } catch (err) {
      this.options.logger.warn({ err: errString(err) }, "loadBrandedProducts failed");
      return [];
    }
  }

  /**
   * Download a catalog reference photo as base64. Only https URLs on an
   * allowed origin are fetched; anything else, or any failure, returns null.
   */
  async fetchCatalogImage(url: string): Promise<{ contentType: string; base64: string } | null> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !this.options.imageOrigins.includes(parsed.origin)) {
        return null;
      }
      // A slow or huge reply must not hold a worker's analysis slot.
      const res = await (this.options.fetch ?? fetch)(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) return null;
      if (Number(res.headers.get("content-length") ?? 0) > 4_000_000) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 4_000_000) return null;
      return { contentType, base64: Buffer.from(bytes).toString("base64") };
    } catch (err) {
      this.options.logger.warn({ err: errString(err) }, "catalog image fetch failed");
      return null;
    }
  }

  /**
   * Reference photos of the matched devices as model image blocks, so the
   * model can recognize a device from a real picture. Bounded (default 2
   * images total) to protect the token budget.
   */
  async buildCatalogImageBlocks(
    matches: CatalogMatch[],
    opts: { maxImages?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const maxImages = opts.maxImages ?? 2;
    // One primary photo per device keeps distinct devices represented within the
    // image budget instead of spending it all on the first device's angles.
    const candidates = matches
      .map((m) => ({ label: m.label, url: catalogImageUrl(m) }))
      .filter((c): c is { label: string; url: string } => !!c.url);
    const blocks: Record<string, unknown>[] = [];
    for (const { label, url } of candidates.slice(0, maxImages)) {
      const image = await this.fetchCatalogImage(url);
      if (!image) continue;
      blocks.push({
        type: "text",
        text: `Reference photo of the catalog device "${label}" — use it to recognize this device if it appears in the room frames, not to measure the room:`,
      });
      blocks.push({
        type: "image_url",
        image_url: { url: `data:${image.contentType};base64,${image.base64}` },
      });
    }
    return blocks;
  }
}
