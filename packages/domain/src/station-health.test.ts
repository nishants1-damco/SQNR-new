import { describe, expect, it } from "vitest";
import { assessStations, stationFrameFromPhoto, type StationFrame } from "./station-health";

/** A clean center sweep: one steady frame in each of the 16 bins. */
const centerSweep = (): StationFrame[] =>
  Array.from({ length: 16 }, (_, i) => ({ station: 0, heading_deg: i * 22.5 + 5, weak: false }));

/** A clean corner sweep: 4 steady frames 40° apart starting at `start`. */
const cornerSweep = (station: number, start: number, weak = false): StationFrame[] =>
  Array.from({ length: 4 }, (_, i) => ({
    station,
    heading_deg: (start + i * 40) % 360,
    weak,
  }));

describe("assessStations", () => {
  it("marks a complete, steady capture as good everywhere", () => {
    const health = assessStations([
      ...centerSweep(),
      ...cornerSweep(1, 100),
      ...cornerSweep(2, 190),
    ]);
    expect(health.map((h) => h.status)).toEqual(["good", "good", "good"]);
    expect(health[1]).toMatchObject({ label: "Corner 1", covered: 4, blurry: 0 });
  });

  it("flags a corner with too few directions", () => {
    const partial = cornerSweep(1, 100).slice(0, 2);
    const [, corner] = assessStations([...centerSweep(), ...partial]);
    expect(corner?.status).toBe("reshoot");
    expect(corner?.reasons).toEqual(["Only 2 of 4 directions captured"]);
  });

  it("flags a fuzzy corner whose frames were all weak", () => {
    const [, corner] = assessStations([...centerSweep(), ...cornerSweep(1, 100, true)]);
    expect(corner?.status).toBe("reshoot");
    expect(corner?.reasons[0]).toMatch(/4 of 4 directions are blurry/);
  });

  it("forgives a weak frame that was re-shot in the same direction", () => {
    const frames = [
      ...centerSweep(),
      ...cornerSweep(1, 100),
      { station: 1, heading_deg: 102, weak: true },
      { station: 1, heading_deg: 142, weak: true },
    ];
    expect(assessStations(frames)[1]?.status).toBe("good");
  });

  it("falls back to motion energy for frames captured before the quality flag", () => {
    const moving = cornerSweep(1, 100).map(({ weak: _weak, ...f }) => ({
      ...f,
      motion_energy: 1.4,
    }));
    expect(assessStations([...centerSweep(), ...moving])[1]?.status).toBe("reshoot");
  });

  it("reports a viewpoint whose frames are all gone", () => {
    const health = assessStations([...centerSweep(), ...cornerSweep(2, 190)]);
    expect(health[1]).toMatchObject({ station: 1, status: "reshoot", frames: 0 });
    expect(health[1]?.reasons).toEqual(["No frames from this viewpoint"]);
  });

  it("places a corner opposite to where its sweep was looking", () => {
    // Sweeping 180°→300° looks south-west to north-west, so the corner is north-east.
    const [, ne] = assessStations([...centerSweep(), ...cornerSweep(1, 180)]);
    expect(ne?.side).toBe("NE");
    // A sweep that crosses north (340°→100°) looks north, so the corner is south.
    const [, , south] = assessStations([
      ...centerSweep(),
      ...cornerSweep(1, 180),
      ...cornerSweep(2, 340),
    ]);
    expect(south?.side).toMatch(/^S/);
    expect(south?.covered).toBe(4);
  });

  it("returns nothing for a capture without frames", () => {
    expect(assessStations([])).toEqual([]);
  });
});

describe("stationFrameFromPhoto", () => {
  it("reads station, motion and the quality flag from a stored photo", () => {
    expect(
      stationFrameFromPhoto({
        heading_deg: "123.5",
        sensor_payload: { station: 2, motion_energy: 0.3, quality: { weak: true, deviation: 8 } },
      }),
    ).toEqual({ station: 2, heading_deg: 123.5, motion_energy: 0.3, weak: true });
  });

  it("tolerates photos captured before quality was recorded", () => {
    expect(stationFrameFromPhoto({ heading_deg: null, sensor_payload: null })).toEqual({
      station: null,
      heading_deg: null,
      motion_energy: null,
      weak: null,
    });
  });
});
