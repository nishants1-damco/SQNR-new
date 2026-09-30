import { describe, expect, it } from "vitest";
import { appendRemoval, readRemovals, removedFrame, summarizeRemovals } from "./frame-removals";

describe("frame removals", () => {
  it("records what a removed photo was", () => {
    expect(
      removedFrame({
        idx: 12,
        heading_deg: "158.4",
        sensor_payload: { station: 0, view: "level" },
      }),
    ).toEqual({ idx: 12, heading_deg: 158.4, station: 0 });
    expect(removedFrame({})).toEqual({ idx: null, heading_deg: null, station: null });
  });

  it("appends to the notes without touching anything else", () => {
    const notes = { stations: 5, frame_removals: [] };
    const next = appendRemoval(notes, {
      at: "2026-09-25T10:00:00.000Z",
      reason: "manual",
      source: "manual",
      frames: [{ idx: 3, heading_deg: 90, station: 1 }],
    });
    expect(next["stations"]).toBe(5);
    expect(readRemovals(next)).toHaveLength(1);
    expect(readRemovals(notes)).toHaveLength(0);
  });

  it("explains recorded removals and flags unrecorded gaps (Hall 2)", () => {
    // 51 frames captured; 0-2 and 15 vanished before recording began,
    // 20 was later removed by the sweep and 30 deleted by hand.
    const stored = Array.from({ length: 51 }, (_, i) => i).filter(
      (i) => ![0, 1, 2, 15, 20, 30].includes(i),
    );
    const notes = {
      frame_removals: [
        {
          at: "2026-09-25T10:00:00.000Z",
          reason: "people",
          source: "privacy-sweep",
          frames: [{ idx: 20, heading_deg: 94, station: 1 }],
        },
        {
          at: "2026-09-25T11:00:00.000Z",
          reason: "manual",
          source: "manual",
          frames: [{ idx: 30, heading_deg: 174, station: 3 }],
        },
      ],
    };
    const summary = summarizeRemovals(notes, stored);
    expect(summary.people).toBe(1);
    expect(summary.manual).toBe(1);
    expect(summary.frames.map((f) => f.idx)).toEqual([30, 20]);
    expect(summary.unrecorded).toEqual([0, 1, 2, 15]);
  });

  it("has nothing to say about an untouched capture", () => {
    expect(summarizeRemovals({}, [0, 1, 2])).toEqual({
      people: 0,
      manual: 0,
      frames: [],
      unrecorded: [],
    });
  });
});
