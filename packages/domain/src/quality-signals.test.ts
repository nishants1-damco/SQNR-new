import { describe, expect, it } from "vitest";
import { computeQualitySignals, qualityLabel } from "./quality-signals";

describe("computeQualitySignals", () => {
  it("returns 0 coverage for empty input", () => {
    const s = computeQualitySignals({ headings: [] });
    expect(s.coverage).toBe(0);
    expect(s.filledBins).toBe(0);
  });

  it("ignores null headings", () => {
    const s = computeQualitySignals({ headings: [null, null, 0] });
    expect(s.filledBins).toBe(1);
  });

  it("hits every bin for a full ring", () => {
    const headings = Array.from({ length: 16 }, (_, i) => i * 22.5);
    const s = computeQualitySignals({ headings });
    expect(s.filledBins).toBe(16);
    expect(s.coverage).toBe(1);
  });

  it("deduplicates headings that fall in the same bin", () => {
    const s = computeQualitySignals({ headings: [10, 11, 12, 100] });
    // 10, 11, 12 all in bin 0; 100 in bin 4.
    expect(s.filledBins).toBe(2);
  });

  it("penalizes stability by median pose drift", () => {
    const s = computeQualitySignals({
      headings: [0],
      poseDrift: [0.0, 0.25, 0.5],
    });
    // Median drift = 0.25 → stability = 1 - 0.25/0.5 = 0.5
    expect(s.stability).toBeCloseTo(0.5, 2);
  });

  it("floors stability at 0 for extreme drift", () => {
    const s = computeQualitySignals({
      headings: [0],
      poseDrift: [2, 2, 2],
    });
    expect(s.stability).toBe(0);
  });
});

describe("qualityLabel", () => {
  it("labels a full ring with no drift as 'good'", () => {
    const headings = Array.from({ length: 16 }, (_, i) => i * 22.5);
    const s = computeQualitySignals({ headings });
    expect(qualityLabel(s)).toBe("good");
  });

  it("labels a sparse ring as 'poor'", () => {
    const s = computeQualitySignals({ headings: [0, 22.5, 45] });
    expect(qualityLabel(s)).toBe("poor");
  });
});
