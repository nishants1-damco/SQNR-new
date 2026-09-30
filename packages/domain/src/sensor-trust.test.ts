// Pure cases split out of the original src/lib/prompt-inputs.test.ts. The
// prompt-file checks move with src/prompts to packages/pipeline in phase 3.
import { describe, expect, it } from "vitest";
import { REFERENCE_SIZES_PROMPT } from "./reference-sizes";
import { acousticsReliable, isTrustedPose } from "./sensor-trust";

describe("REFERENCE_SIZES_PROMPT", () => {
  it("gives ranges without tying them to any country's standards", () => {
    expect(REFERENCE_SIZES_PROMPT).toContain("sizes vary by country and organization");
    expect(REFERENCE_SIZES_PROMPT).toContain("Displays");
    expect(REFERENCE_SIZES_PROMPT).not.toMatch(/India|United States|IS 1948/);
    expect(REFERENCE_SIZES_PROMPT).not.toContain("80 in");
  });
});

describe("sensor trust", () => {
  it("shows only positions with little estimated drift", () => {
    expect(isTrustedPose({ drift_m: 0.4 })).toBe(true);
    expect(isTrustedPose({ drift_m: 23 })).toBe(false);
    expect(isTrustedPose({ drift_m: null })).toBe(true);
    expect(isTrustedPose(null)).toBe(false);
  });

  it("uses acoustic cross-checks only from a clean, repeatable probe", () => {
    expect(acousticsReliable({ ping_snr_db: 20, chirps: 3, rt60_spread_s: 0.05 })).toBe(true);
    expect(acousticsReliable({ ping_snr_db: 6, chirps: 1 })).toBe(false);
    expect(acousticsReliable({ ping_snr_db: 20, chirps: 4, rt60_spread_s: 0.6 })).toBe(false);
    expect(acousticsReliable({ rt60_s: 0.16 })).toBe(false);
    expect(acousticsReliable(null)).toBe(false);
  });
});
