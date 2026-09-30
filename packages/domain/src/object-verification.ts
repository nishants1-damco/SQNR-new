// Zoom-in verification of detected objects (and visual catalog matching).
//
// The detection pass sees whole frames; small devices and brand markings are a
// few dozen pixels there. For each detection, the server crops the object out
// of its clearest full-resolution frame and asks the model to confirm what it
// is — and, when catalog products of the same kind exist, whether it is one of
// them: by reference photo when the product has one, by name and specs when
// it doesn't.
//
// This module holds the pure decisions (what to verify, which box, which
// catalog candidates, how verdicts change the inventory); the server module
// does the cropping and the model calls.

import { catalogCategoryFor } from "./product-catalog";
import { isDevice } from "./object-scope";
import type { NormalizedBox } from "./image-crop";

export interface FrameBox extends NormalizedBox {
  frame: number;
}

export interface InventoryObject {
  label: string;
  category: string;
  confidence: number;
  width_m?: number;
  depth_m?: number;
  height_m?: number;
  frame_boxes?: FrameBox[];
  /** Catalog product this object was verified to be. */
  catalog_match?: string | null;
  [key: string]: unknown;
}

/** A catalog product the object may be; `hasImage` decides photo vs name comparison. */
export interface CatalogCandidate {
  id: string;
  label: string;
  category: string;
  brand: string | null;
  model: string | null;
  width_m: number | null;
  height_m: number | null;
  depth_m: number | null;
  hasImage: boolean;
  /** Lower is closer (text-retrieval rank); products found only by category rank last. */
  rank: number;
}

export interface Verdict {
  object: number;
  present: boolean;
  label: string;
  category: string;
  brand: string | null;
  model: string | null;
  catalog_match: string | null;
  confidence: number;
}

/** Most objects checked per scan; bounds cost and time. */
export const MAX_VERIFIED_OBJECTS = 24;
/** Catalog candidates shown per object. */
export const MAX_CANDIDATES_PER_OBJECT = 3;
/** A "not present" verdict at or above this confidence removes the detection. */
export const REMOVE_CONFIDENCE = 0.6;

const area = (b: NormalizedBox) => Math.abs(b.x1 - b.x0) * Math.abs(b.y1 - b.y0);

/** The largest usable box: the frame where the object shows the most detail. */
export function pickBestBox(
  boxes: FrameBox[] | undefined,
  hasFrame: (frame: number) => boolean,
): FrameBox | null {
  let best: FrameBox | null = null;
  for (const b of boxes ?? []) {
    if (!Number.isInteger(b.frame) || !hasFrame(b.frame)) continue;
    if (area(b) <= 0) continue;
    if (!best || area(b) > area(best)) best = b;
  }
  return best;
}

/** Catalog products this object may be: same catalog category, closest first. */
export function candidatesFor(
  o: Pick<InventoryObject, "label" | "category">,
  pool: CatalogCandidate[],
): CatalogCandidate[] {
  const category = catalogCategoryFor(String(o.category ?? ""), String(o.label ?? ""));
  if (!category) return [];
  return pool
    .filter((c) => c.category === category)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_CANDIDATES_PER_OBJECT);
}

/**
 * Indexes of the objects worth a zoom-in, in priority order: devices first
 * (small, brand-bearing, what downstream apps need), then objects that may be
 * a catalog product, then the least confident.
 */
export function chooseObjectsToVerify(
  objects: InventoryObject[],
  hasBox: (o: InventoryObject) => boolean,
  hasCandidates: (o: InventoryObject) => boolean,
  max = MAX_VERIFIED_OBJECTS,
): number[] {
  const score = (o: InventoryObject) =>
    (isDevice(o.label) ? 2 : 0) + (hasCandidates(o) ? 1 : 0) + (1 - (Number(o.confidence) || 0));
  return objects
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => hasBox(o))
    .sort((a, b) => score(b.o) - score(a.o))
    .slice(0, max)
    .map(({ i }) => i);
}

/**
 * Apply verdicts to the inventory. `shown[k]` is the inventory index of the
 * object labeled k in the prompt; `candidateIds` maps "C1"-style ids to
 * candidates. Returns the new inventory and human-readable notes.
 */
export function applyVerdicts(
  objects: InventoryObject[],
  shown: number[],
  verdicts: Verdict[],
  candidateIds: Map<string, CatalogCandidate>,
): { objects: InventoryObject[]; notes: string[] } {
  const notes: string[] = [];
  const next = objects.map((o) => ({ ...o }));
  const removed = new Set<number>();

  for (const v of verdicts) {
    const index = shown[v.object];
    if (index == null || !next[index]) continue;
    const o = next[index];
    const before = o.label;
    const confidence = Math.min(1, Math.max(0, Number(v.confidence) || 0));

    if (v.present === false) {
      if (confidence >= REMOVE_CONFIDENCE) {
        removed.add(index);
        notes.push(`Removed "${before}": the zoom-in check found no such object.`);
      }
      continue;
    }

    const candidate = v.catalog_match ? candidateIds.get(v.catalog_match.trim()) : undefined;
    let label = v.label?.trim() || before;
    const brand = candidate?.brand ?? v.brand?.trim() ?? null;
    // Brand and model in the label let the catalog size lookup find the product.
    if (brand && !label.toLowerCase().includes(brand.toLowerCase())) label = `${brand} ${label}`;
    const model = candidate?.model ?? v.model?.trim() ?? null;
    if (model && !label.toLowerCase().includes(model.toLowerCase())) label = `${label} ${model}`;

    o.label = label;
    o.category = candidate?.category ?? (v.category?.trim() || o.category);
    o.confidence = confidence;
    if (candidate) {
      o.catalog_match = candidate.label;
      notes.push(`Identified "${before}" as catalog product "${candidate.label}".`);
    } else if (label !== before) {
      notes.push(`Zoom-in check relabeled "${before}" as "${label}".`);
    }
  }

  return { objects: next.filter((_, i) => !removed.has(i)), notes };
}
