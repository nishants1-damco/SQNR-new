import { describe, expect, it } from "vitest";
import { makeLeg, shellFromWalk } from "./walk-legs";

describe("makeLeg", () => {
  it("computes straight-line distance and axis components", () => {
    const leg = makeLeg(
      0,
      { x: 0, y: 0, travelled_m: 0, t_s: 0, steps: 0 },
      { x: 3, y: 4, travelled_m: 5, t_s: 6, steps: 6 },
    );
    expect(leg.distance_m).toBeCloseTo(5, 2);
    expect(leg.dx).toBe(3);
    expect(leg.dy).toBe(4);
    expect(leg.path_m).toBeCloseTo(5, 2);
  });

  it("penalises wandering paths (path >> distance)", () => {
    const wandering = makeLeg(
      0,
      { x: 0, y: 0, travelled_m: 0, t_s: 0, steps: 0 },
      { x: 3, y: 0, travelled_m: 10, t_s: 8, steps: 12 },
    );
    const straight = makeLeg(
      0,
      { x: 0, y: 0, travelled_m: 0, t_s: 0, steps: 0 },
      { x: 3, y: 0, travelled_m: 3, t_s: 4, steps: 4 },
    );
    expect(wandering.quality).toBeLessThan(straight.quality);
  });
});

describe("shellFromWalk", () => {
  it("returns null when there aren't enough usable legs", () => {
    const one = makeLeg(
      0,
      { x: 0, y: 0, travelled_m: 0, t_s: 0, steps: 0 },
      { x: 3, y: 0, travelled_m: 3, t_s: 4, steps: 4 },
    );
    expect(shellFromWalk([one])).toBeNull();
  });

  it("recovers a rectangle from four closed legs", () => {
    // Walk 3m east, 4m north, 3m west, 4m south — closes exactly.
    const legs = [
      makeLeg(
        0,
        { x: 0, y: 0, travelled_m: 0, t_s: 0, steps: 0 },
        { x: 3, y: 0, travelled_m: 3, t_s: 4, steps: 4 },
      ),
      makeLeg(
        1,
        { x: 3, y: 0, travelled_m: 3, t_s: 5, steps: 4 },
        { x: 3, y: 4, travelled_m: 7, t_s: 10, steps: 8 },
      ),
      makeLeg(
        2,
        { x: 3, y: 4, travelled_m: 7, t_s: 11, steps: 8 },
        { x: 0, y: 4, travelled_m: 10, t_s: 15, steps: 12 },
      ),
      makeLeg(
        3,
        { x: 0, y: 4, travelled_m: 10, t_s: 16, steps: 12 },
        { x: 0, y: 0, travelled_m: 14, t_s: 21, steps: 16 },
      ),
    ];
    const shell = shellFromWalk(legs);
    expect(shell).not.toBeNull();
    expect(shell!.width_m).toBeGreaterThan(2.5);
    expect(shell!.width_m).toBeLessThanOrEqual(3);
    expect(shell!.length_m).toBeGreaterThan(3.4);
    expect(shell!.length_m).toBeLessThanOrEqual(4);
    expect(shell!.closure_error_m).toBeLessThan(0.1);
  });
});
