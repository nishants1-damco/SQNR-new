// Pure cases split out of the original src/lib/accuracy-pipeline.test.ts. The
// Claude-message and schema cases move with packages/pipeline in phase 3.
import { describe, expect, it } from "vitest";
import { batchViewpoints, canonicalObjectLabel, mergeBatchInventories } from "./inventory-merge";
import { DEVICE_SCOPE_PROMPT, keepDetectedObject } from "./object-scope";

describe("batchViewpoints", () => {
  const frame = (heading: number) => ({
    heading,
    blocks: [`caption ${heading}`, `image ${heading}`],
  });

  it("splits a 16-frame center into two batches and keeps each corner whole", () => {
    const batches = batchViewpoints([
      { station: 0, frames: Array.from({ length: 16 }, (_, i) => frame(i * 22.5)) },
      { station: 1, frames: [frame(100), frame(140), frame(180), frame(220)] },
    ]);
    expect(batches.map((b) => [b.station, b.blocks.length])).toEqual([
      [0, 16],
      [0, 16],
      [1, 8],
    ]);
    expect(batches[2]?.scope).toBe(
      "viewpoint 2 (near a room corner), headings 100°, 140°, 180°, 220°",
    );
  });
});

describe("mergeBatchInventories", () => {
  const obj = (label: string, wall: string, headings: number[], confidence = 0.8) => ({
    label,
    against_wall: wall,
    confidence,
    supporting_headings_deg: headings,
  });

  it("counts an object seen from several viewpoints once", () => {
    const merged = mergeBatchInventories([
      { station: 0, objects: [obj("black leather sofa", "north", [0], 0.7)] },
      { station: 1, objects: [obj("couch", "north", [30], 0.9)] },
      { station: 2, objects: [obj("Sofa", "north", [330])] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.9);
    expect(merged[0]?.supporting_headings_deg).toEqual([0, 30, 330]);
  });

  it("keeps distinct objects of one kind seen together", () => {
    const chairs = [1, 2, 3, 4].map((i) => obj("dining chair", "none", [i * 10]));
    const merged = mergeBatchInventories([
      { station: 1, objects: chairs },
      { station: 2, objects: chairs.slice(0, 2) },
    ]);
    expect(merged).toHaveLength(4);
  });

  it("adds up the batches of one viewpoint (they cover different headings)", () => {
    const merged = mergeBatchInventories([
      { station: 0, objects: [obj("window bench", "east", [90])] },
      { station: 0, objects: [obj("window bench", "east", [270])] },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("normalizes labels", () => {
    expect(canonicalObjectLabel("Wall-mounted black TV")).toBe("television");
  });
});

describe("keepDetectedObject", () => {
  const small = { width_m: 0.3, depth_m: 0.1, height_m: 0.15 };

  it("always keeps AV / IT devices, however small", () => {
    for (const label of [
      "conference camera",
      "ceiling microphone",
      "touch panel",
      "AIO bar",
      "video bar",
      "bookshelf speakers",
      "wireless access point",
      "network switch",
    ]) {
      expect(keepDetectedObject({ label, ...small }), label).toBe(true);
    }
  });

  it("drops small clutter but keeps major items", () => {
    expect(keepDetectedObject({ label: "coffee mug", ...small })).toBe(false);
    expect(keepDetectedObject({ label: "light switch", ...small })).toBe(false);
    expect(keepDetectedObject({ label: "picture frame", width_m: 0.8 })).toBe(false);
    expect(keepDetectedObject({ label: "dining chair", ...small })).toBe(true);
    expect(keepDetectedObject({ label: "bed frame", width_m: 1.6 })).toBe(true);
  });

  it("falls back to size for unknown labels", () => {
    expect(keepDetectedObject({ label: "sculpture", width_m: 0.4 })).toBe(false);
    expect(keepDetectedObject({ label: "sculpture", height_m: 1.2 })).toBe(true);
  });

  it("tells the model about every device the filter keeps", () => {
    expect(DEVICE_SCOPE_PROMPT).toContain("video bar");
    expect(DEVICE_SCOPE_PROMPT).toContain("touch panel");
  });
});
