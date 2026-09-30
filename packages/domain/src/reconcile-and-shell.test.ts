import { describe, expect, it } from "vitest";
import { isPortalPart, objectsToRestore, objectType } from "./object-reconcile";
import { MAX_SHELL_RATIO, shellAgrees, shellDisagreement } from "./shell-check";

const o = (label: string, category: string, confidence = 0.8, x = 0, y = 0) => ({
  label,
  category,
  confidence,
  x_m: x,
  y_m: y,
});

describe("objectsToRestore", () => {
  it("does not restore objects the review merely renamed (Hall 2)", () => {
    // What the review kept, under its own names.
    const reviewed = [
      o("flat-screen smart TV (Google TV, ~40-43 in)", "tv"),
      o("3-seater sofa (patterned cover, dark wood frame)", "sofa", 0.8, 1.8, 1.6),
      o("wooden diwan sofa-cum-bed with cream quilted cover", "sofa", 0.85, 0.7, 8.3),
      o("wall-mounted split inverter AC indoor unit", "hvac unit"),
      o("storage coffee table with marble-look top and drawers", "coffee table"),
      o("arched wall niche with wood shelf", "built-in shelving"),
    ];
    // The same objects as the zoom-in check named them.
    const inventory = [
      o("flat-screen smart TV with Google TV interface (likely Xiaomi)", "tv", 0.85),
      o("L-shaped patterned fabric sofa with ottoman", "sofa", 0.6),
      o("wooden diwan sofa-cum-bed with cream quilted cover and patterned cushions", "sofa"),
      o("wall-mounted split inverter air conditioner indoor unit", "hvac unit", 0.9),
      o("storage coffee table with marble-pattern plastic cover and drawer", "coffee table"),
      o("arched wall niche with shelf holding bottles", "built-in shelving", 0.85),
      o("wooden entry door (open)", "door", 0.85),
      o("grilled window with grey curtain", "window"),
    ];
    expect(objectsToRestore(reviewed, inventory, 0.45)).toEqual([]);
  });

  it("restores an instance the review really dropped, farthest from the kept ones", () => {
    const reviewed = [o("maroon plastic chair", "chair", 0.8, 2, -8)];
    const earlier = [
      o("plastic chair", "chair", 0.8, 2.05, -8.1),
      o("plastic chair by the window", "chair", 0.8, -1, 3),
    ];
    const restored = objectsToRestore(reviewed, earlier, 0.45);
    expect(restored.map((r) => r.label)).toEqual(["plastic chair by the window"]);
  });

  it("never restores door or window parts, or low-confidence detections", () => {
    const earlier = [
      o("wooden entry door leaf (open)", "door", 0.9),
      o("grilled glazed panel with grey curtains", "window", 0.9),
      o("white laminate sliding door", "furniture", 0.9),
      o("framed picture", "decor", 0.3),
    ];
    expect(objectsToRestore([], earlier, 0.45)).toEqual([]);
  });

  it("restores a whole type the review lost entirely", () => {
    const restored = objectsToRestore([], [o("ceiling fan", "ceiling fan", 0.9)], 0.6);
    expect(restored).toHaveLength(1);
  });

  it("treats synonyms as one type", () => {
    expect(objectType(o("TV", "television"))).toBe(objectType(o("screen", "tv")));
    expect(objectType(o("AC", "air conditioner"))).toBe("hvac unit");
    expect(objectType(o("black leather sofa", ""))).toBe("sofa");
    expect(isPortalPart(o("frosted glass sliding bathroom door", "furniture"))).toBe(true);
    expect(isPortalPart(o("wooden entry door leaf (open)", "furniture"))).toBe(true);
    expect(isPortalPart(o("window bench", "bench"))).toBe(false);
    expect(isPortalPart(o("sofa under the window", "sofa"))).toBe(false);
  });
});

describe("shell check", () => {
  it("rejects the 4.55 x 17.39 m triangulation for a ~3 x 4.3 m room (Hall 2)", () => {
    const estimate = { width_m: 3.0, length_m: 4.3 };
    expect(shellAgrees({ width_m: 4.55, length_m: 17.39 }, estimate)).toBe(false);
    expect(shellDisagreement({ width_m: 4.55, length_m: 17.39 }, estimate)).toBeCloseTo(4.04, 2);
  });

  it("accepts a measurement within the tolerance", () => {
    const estimate = { width_m: 3.0, length_m: 4.3 };
    expect(shellAgrees({ width_m: 3.4, length_m: 3.9 }, estimate)).toBe(true);
    expect(shellAgrees({ width_m: 3.0 * MAX_SHELL_RATIO, length_m: 4.3 }, estimate)).toBe(true);
    expect(shellAgrees({ width_m: 3.0 * MAX_SHELL_RATIO + 0.1, length_m: 4.3 }, estimate)).toBe(
      false,
    );
  });

  it("rejects unusable sizes", () => {
    expect(shellAgrees({ width_m: 0, length_m: 4 }, { width_m: 3, length_m: 4 })).toBe(false);
  });
});
