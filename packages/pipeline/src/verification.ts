// Zoom-in verification pass, ported from `src/lib/object-verification.server.ts`.
// See @spatial/domain/object-verification for the decisions; this module crops
// the objects out of the full-resolution frames, fetches catalog reference
// photos, and asks the model for verdicts.
import { cropRegion, decodeJpeg, encodeJpeg } from "@spatial/domain/image-crop";
import {
  applyVerdicts,
  type CatalogCandidate,
  candidatesFor,
  chooseObjectsToVerify,
  type InventoryObject,
  pickBestBox,
  type Verdict,
} from "@spatial/domain/object-verification";
import { type CatalogMatch, catalogImageUrl } from "@spatial/domain/product-catalog";
import type { CatalogSource } from "./catalog";
import { VERIFICATION_SCHEMA } from "./llm/schemas";
import { errString, type PipelineLogger } from "./logger";
import { bytesToBase64, mapWithConcurrency, type Passes } from "./passes";
import { prompt } from "./prompts";

type Block = Record<string, unknown>;

/** Objects per model call: enough to share catalog photos, few enough to stay focused. */
const OBJECTS_PER_CALL = 6;
const CALL_CONCURRENCY = 4;

const fmt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?");

/** Catalog rows to candidates; only specific products (brand or model) can be "the same product". */
export function toCandidates(rows: CatalogMatch[]): CatalogCandidate[] {
  const seen = new Set<string>();
  const out: CatalogCandidate[] = [];
  rows.forEach((row, rank) => {
    if (seen.has(row.id) || (!row.brand && !row.model)) return;
    seen.add(row.id);
    out.push({
      id: row.id,
      label: row.label,
      category: row.category,
      brand: row.brand,
      model: row.model,
      width_m: row.width_m == null ? null : Number(row.width_m),
      height_m: row.height_m == null ? null : Number(row.height_m),
      depth_m: row.depth_m == null ? null : Number(row.depth_m),
      hasImage: !!catalogImageUrl(row),
      rank,
    });
  });
  return out;
}

export async function verifyInventoryObjects(opts: {
  passes: Passes;
  catalogSource: CatalogSource;
  logger: PipelineLogger;
  objects: InventoryObject[];
  /** Full-resolution JPEG bytes by frame number. */
  frameBytes: (Uint8Array | undefined)[];
  /** Catalog rows to match against (text-retrieved matches + branded products). */
  catalog: CatalogMatch[];
}): Promise<{ objects: InventoryObject[]; notes: string[] }> {
  const { passes, catalogSource, logger, objects, frameBytes } = opts;
  const pool = toCandidates(opts.catalog);
  const rowsById = new Map(opts.catalog.map((r) => [r.id, r]));
  const hasFrame = (frame: number) => !!frameBytes[frame];

  const chosen = chooseObjectsToVerify(
    objects,
    (o) => !!pickBestBox(o.frame_boxes, hasFrame),
    (o) => candidatesFor(o, pool).length > 0,
  );
  if (chosen.length === 0) return { objects, notes: [] };

  // Crop every chosen object, decoding each frame once.
  const crops = new Map<number, string>();
  const byFrame = new Map<
    number,
    { index: number; box: NonNullable<ReturnType<typeof pickBestBox>> }[]
  >();
  for (const index of chosen) {
    const box = pickBestBox(objects[index]?.frame_boxes, hasFrame);
    if (!box) continue;
    byFrame.set(box.frame, [...(byFrame.get(box.frame) ?? []), { index, box }]);
  }
  for (const [frame, items] of byFrame) {
    try {
      const image = decodeJpeg(frameBytes[frame] as Uint8Array);
      for (const { index, box } of items) {
        const jpeg = encodeJpeg(cropRegion(image, box));
        crops.set(index, `data:image/jpeg;base64,${bytesToBase64(jpeg)}`);
      }
    } catch (err) {
      logger.warn({ frame, err: errString(err) }, "could not crop frame");
    }
  }
  const shown = chosen.filter((i) => crops.has(i));
  if (shown.length === 0) return { objects, notes: [] };

  // Catalog candidates, with globally unique prompt ids and reference photos.
  const candidatesByObject = new Map(
    shown.map((i) => [i, candidatesFor(objects[i] as InventoryObject, pool)]),
  );
  const candidateIds = new Map<string, CatalogCandidate>();
  const idOf = new Map<string, string>();
  for (const list of candidatesByObject.values()) {
    for (const c of list) {
      if (idOf.has(c.id)) continue;
      const id = `C${idOf.size + 1}`;
      idOf.set(c.id, id);
      candidateIds.set(id, c);
    }
  }
  const photos = new Map<string, string | null>();
  await Promise.all(
    [...candidateIds.values()].map(async (c) => {
      const row = rowsById.get(c.id);
      const url = row ? catalogImageUrl(row) : null;
      const image = url ? await catalogSource.fetchCatalogImage(url) : null;
      photos.set(c.id, image ? `data:${image.contentType};base64,${image.base64}` : null);
    }),
  );

  const describeCandidate = (c: CatalogCandidate): Block[] => {
    const id = idOf.get(c.id) as string;
    const text = `Catalog product ${id}: "${c.label}"${c.brand ? `, brand ${c.brand}` : ""}${
      c.model ? `, model ${c.model}` : ""
    }, ${fmt(c.width_m)} m wide x ${fmt(c.height_m)} m high x ${fmt(c.depth_m)} m deep.`;
    const photo = photos.get(c.id);
    return photo
      ? [
          { type: "text", text: `${text} Reference photo:` },
          { type: "image_url", image_url: { url: photo } },
        ]
      : [
          {
            type: "text",
            text: `${text} No reference photo on file: compare by name and specifications.`,
          },
        ];
  };

  const batches: number[][] = [];
  for (let i = 0; i < shown.length; i += OBJECTS_PER_CALL) {
    batches.push(shown.slice(i, i + OBJECTS_PER_CALL));
  }

  const verdictLists = await mapWithConcurrency(batches, CALL_CONCURRENCY, async (batch) => {
    const content: Block[] = [];
    const batchCandidates = [
      ...new Map(
        batch.flatMap((i) => candidatesByObject.get(i) ?? []).map((c) => [c.id, c]),
      ).values(),
    ];
    if (batchCandidates.length) {
      content.push({ type: "text", text: "CATALOG CANDIDATES:" });
      for (const c of batchCandidates) content.push(...describeCandidate(c));
    }
    content.push({ type: "text", text: "OBJECTS TO VERIFY:" });
    for (const index of batch) {
      const o = objects[index] as InventoryObject;
      const number = shown.indexOf(index);
      const candidates = (candidatesByObject.get(index) ?? []).map((c) => idOf.get(c.id));
      content.push({
        type: "text",
        text: `Object ${number}: detected as "${o.label}" (category: ${o.category}), estimated ${fmt(
          o.width_m,
        )} x ${fmt(o.depth_m)} x ${fmt(o.height_m)} m.${
          candidates.length ? ` Catalog candidates: ${candidates.join(", ")}.` : ""
        } Crop:`,
      });
      content.push({ type: "image_url", image_url: { url: crops.get(index) as string } });
    }
    try {
      const parsed = await passes.requestJson<{ verdicts?: Verdict[] }>(
        passes.primaryModel,
        [
          { role: "system", content: prompt("object-verification") },
          { role: "user", content },
        ],
        // Focused crops, one question each: medium effort is enough.
        { schema: VERIFICATION_SCHEMA, effort: "medium", step: "verification" },
      );
      return Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    } catch (err) {
      logger.warn({ err: errString(err) }, "verification call failed");
      return [];
    }
  });

  return applyVerdicts(objects, shown, verdictLists.flat(), candidateIds);
}
