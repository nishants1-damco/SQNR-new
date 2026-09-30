import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Fixture, loadFixtures, parseJsonc } from "./fixtures";
import { ReplayProvider, requestTextHash } from "./providers";
import { scoreFixture } from "./score";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

describe("fixtures", () => {
  it("parse with comments, as the original living-room-1.json was written", () => {
    const original = `// Sample ground-truth for the reconstruction eval.
//
// Each fixture is a hand-measured room.
{
  "id": "x", /* inline */ "url": "https://example.com/a//b",
  "ground_truth": { "width_m": 3.0 }
}`;
    expect(parseJsonc(original)).toEqual({
      id: "x",
      url: "https://example.com/a//b",
      ground_truth: { width_m: 3 },
    });
  });

  it("all load, and the synthetic one has a capture to replay", () => {
    const fixtures = loadFixtures(FIXTURES);
    expect(fixtures.map((f) => f.name)).toEqual(["bedroom-1", "living-room-1", "synthetic-studio"]);
    expect(
      fixtures.find((f) => f.name === "synthetic-studio")?.capture?.capture.photos,
    ).toHaveLength(4);
    expect(() =>
      JSON.parse(readFileSync(join(FIXTURES, "living-room-1.json"), "utf8")),
    ).not.toThrow();
  });
});

describe("scoreFixture", () => {
  const fixture: Fixture = {
    id: "room",
    label: "room",
    ground_truth: {
      width_m: 3,
      length_m: 4,
      height_m: 2.5,
      objects: [{ label: "Sofa", category: "seating", width_m: 2.1 }],
      portals: [{ kind: "door", wall: "north", width_m: 0.9 }],
    },
    tolerance: { shell_m: 0.15, object_width_m: 0.2, portal_width_m: 0.05 },
  };

  it("passes inside the tolerances, matching objects by label or else category", () => {
    const result = scoreFixture(fixture, {
      width_m: 3.1,
      length_m: 3.9,
      height_m: 2.5,
      objects: [{ label: "3-seat fabric sofa", category: "seating", width_m: 2.2 }],
      portals: [{ kind: "door", wall: "north", width_m: 0.92 }],
    });
    expect(result).toEqual({ id: "room", status: "pass", failures: [] });
  });

  it("lists every miss", () => {
    const result = scoreFixture(fixture, { width_m: 3.5, length_m: 4, objects: [], portals: [] });
    expect(result.failures).toEqual([
      "width_m: expected 3 ±0.15, got 3.5",
      "height_m: actual missing",
      'object "Sofa" missing',
      "portal door on north missing",
    ]);
  });
});

describe("ReplayProvider", () => {
  const request = (text: string) => ({
    model: "m",
    step: "inventory-batch",
    messages: [{ role: "user" as const, content: [{ type: "text", text }] }],
  });

  it("answers the matching recorded call, else the next unused one, counting the drift", async () => {
    const replay = new ReplayProvider(
      {
        "inventory-batch": [
          { textHash: requestTextHash(request("corner 1")), reply: "one" },
          { textHash: requestTextHash(request("corner 2")), reply: "two" },
        ],
      },
      { kind: "claude", primaryModel: "m", fallbackModel: "m", budgets: {} as never },
    );
    expect(await replay.complete(request("corner 2"))).toBe("two");
    expect(await replay.complete(request("changed prompt"))).toBe("one");
    expect(replay.drift).toBe(1);
    await expect(replay.complete(request("corner 1"))).rejects.toThrow(/No recorded reply/);
  });
});
