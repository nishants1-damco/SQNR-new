// Pure cases split out of the original src/lib/verification-and-capture.test.ts.
// Frame-quality cases move with apps/web (phase 4) and `toCandidates` with
// packages/pipeline (phase 3).
import { describe, expect, it } from "vitest";
import { encode } from "jpeg-js";
import { boxToPixels, cropRegion, decodeJpeg, encodeJpeg } from "./image-crop";
import { selectCornerFrames } from "./frame-selection";
import {
  applyVerdicts,
  candidatesFor,
  chooseObjectsToVerify,
  pickBestBox,
  type CatalogCandidate,
  type InventoryObject,
  type Verdict,
} from "./object-verification";

/** 200x100 JPEG: left half red, right half blue. */
function twoToneJpeg(): Uint8Array {
  const width = 200;
  const height = 100;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = x < width / 2;
      data[i] = left ? 220 : 20;
      data[i + 2] = left ? 20 : 220;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(encode({ width, height, data }, 95).data);
}

describe("image crop", () => {
  it("crops the requested region out of a real JPEG", () => {
    const image = decodeJpeg(twoToneJpeg());
    const crop = cropRegion(image, { x0: 0.6, y0: 0.2, x1: 0.95, y1: 0.8 }, { minEdgePx: 10 });
    let red = 0;
    let blue = 0;
    for (let i = 0; i < crop.data.length; i += 4) {
      red += crop.data[i] ?? 0;
      blue += crop.data[i + 2] ?? 0;
    }
    expect(blue).toBeGreaterThan(red * 3);
    // Round-trips back to JPEG bytes (SOI marker).
    const bytes = encodeJpeg(crop);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it("pads, grows tiny boxes to a minimum size and stays inside the image", () => {
    expect(boxToPixels({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, 1000, 1000)).toEqual({
      x: 370,
      y: 370,
      w: 260,
      h: 260,
    });
    const tiny = boxToPixels({ x0: 0.99, y0: 0.99, x1: 1, y1: 1 }, 1000, 800, { minEdgePx: 160 });
    expect(tiny.w).toBe(160);
    expect(tiny.x + tiny.w).toBeLessThanOrEqual(1000);
    expect(tiny.y + tiny.h).toBeLessThanOrEqual(800);
  });

  it("downscales large crops to bound image tokens", () => {
    const image = { width: 2000, height: 1000, data: new Uint8Array(2000 * 1000 * 4) };
    const crop = cropRegion(image, { x0: 0, y0: 0, x1: 1, y1: 1 }, { maxEdgePx: 500 });
    expect(Math.max(crop.width, crop.height)).toBe(500);
  });
});

describe("selectCornerFrames", () => {
  const f = (heading: number, sharpness: number, view: "level" | "low" = "level") => ({
    heading_deg: heading,
    sharpness,
    view,
  });

  it("keeps all four ~40°-apart directions (not 2 per 90° sector) plus the low view", () => {
    const picked = selectCornerFrames(
      [f(100, 200), f(140, 200), f(180, 200), f(220, 200), f(160, 150, "low")],
      4,
      true,
    );
    expect(picked.map((p) => p.heading_deg)).toEqual([100, 140, 180, 220, 160]);
  });

  it("keeps the sharper frame of a direction that was re-shot", () => {
    const picked = selectCornerFrames([f(100, 20), f(104, 250), f(140, 200)], 4, false);
    expect(picked.map((p) => p.sharpness)).toEqual([250, 200]);
  });

  it("handles a sweep across north and caps the direction count", () => {
    const picked = selectCornerFrames([f(340, 50), f(20, 300), f(60, 200), f(100, 100)], 3, false);
    expect(picked.map((p) => p.heading_deg)).toEqual([20, 60, 100]);
  });
});

describe("object verification", () => {
  const candidate = (over: Partial<CatalogCandidate>): CatalogCandidate => ({
    id: "id",
    label: "Product",
    category: "tv",
    brand: null,
    model: null,
    width_m: 1,
    height_m: 0.6,
    depth_m: 0.2,
    hasImage: false,
    rank: 0,
    ...over,
  });
  const obj = (over: Partial<InventoryObject>): InventoryObject => ({
    label: "object",
    category: "other",
    confidence: 0.8,
    ...over,
  });

  it("picks the largest box on an available frame", () => {
    const boxes = [
      { frame: 1, x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 },
      { frame: 2, x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.6 },
      { frame: 9, x0: 0, y0: 0, x1: 1, y1: 1 },
    ];
    expect(pickBestBox(boxes, (f) => f !== 9)?.frame).toBe(2);
    expect(pickBestBox(undefined, () => true)).toBeNull();
  });

  it("offers catalog candidates of the object's catalog category, closest first", () => {
    const pool = [
      candidate({ id: "benq", category: "monitor", rank: 2 }),
      candidate({ id: "xiaomi", category: "tv", rank: 1 }),
      candidate({ id: "other-tv", category: "tv", rank: 0 }),
    ];
    expect(
      candidatesFor(obj({ label: "wall-mounted television", category: "electronics" }), pool).map(
        (c) => c.id,
      ),
    ).toEqual(["other-tv", "xiaomi"]);
    expect(candidatesFor(obj({ label: "sofa", category: "furniture" }), pool)).toEqual([]);
  });

  it("verifies devices and catalog look-alikes first", () => {
    const objects = [
      obj({ label: "sofa", confidence: 0.5 }),
      obj({ label: "conference camera", confidence: 0.9 }),
      obj({ label: "monitor", confidence: 0.9 }),
      obj({ label: "rug", confidence: 0.2 }),
      obj({ label: "no box" }),
    ];
    const order = chooseObjectsToVerify(
      objects,
      (o) => o.label !== "no box",
      (o) => o.label === "monitor",
    );
    expect(order).toEqual([2, 1, 3, 0]);
  });

  it("applies verdicts: removes confident false positives, relabels, and matches catalog products", () => {
    const objects = [
      obj({ label: "monitor", category: "electronics" }),
      obj({ label: "picture of a tv" }),
      obj({ label: "shadowy thing" }),
      obj({ label: "speaker" }),
    ];
    const benq = candidate({
      id: "b1",
      label: "BenQ GW2786TC 27-inch IPS monitor",
      category: "monitor",
      brand: "BenQ",
      model: "GW2786TC",
    });
    const verdict = (over: Partial<Verdict>): Verdict => ({
      object: 0,
      present: true,
      label: "object",
      category: "other",
      brand: null,
      model: null,
      catalog_match: null,
      confidence: 0.9,
      ...over,
    });
    const { objects: out, notes } = applyVerdicts(
      objects,
      [0, 1, 2, 3],
      [
        verdict({ object: 0, label: "27-inch monitor", catalog_match: "C1", confidence: 0.95 }),
        verdict({ object: 1, present: false, confidence: 0.9 }),
        verdict({ object: 2, present: false, confidence: 0.3 }),
        verdict({ object: 3, label: "bookshelf speaker", brand: "Sonos", catalog_match: "C9" }),
      ],
      new Map([["C1", benq]]),
    );
    expect(out.map((o) => o.label)).toEqual([
      "BenQ 27-inch monitor GW2786TC",
      "shadowy thing",
      "Sonos bookshelf speaker",
    ]);
    expect(out[0]).toMatchObject({
      category: "monitor",
      catalog_match: benq.label,
      confidence: 0.95,
    });
    expect(out[2]?.catalog_match).toBeUndefined();
    expect(notes.join(" ")).toMatch(/Removed "picture of a tv"/);
  });
});
