import { describe, expect, it } from "vitest";
import {
  analysisDeadlineFor,
  analysisDeadlineMs,
  CLOUD_ANALYSIS_DEADLINE_MS,
  isAnalysisStale,
  LOCAL_ANALYSIS_DEADLINE_MS,
} from "./analysis-deadline";

const T0 = Date.parse("2026-09-24T10:00:00.000Z");

describe("analysisDeadlineFor", () => {
  it("gives local runs the long allowance and cloud runs the short one", () => {
    expect(Date.parse(analysisDeadlineFor("ollama", T0))).toBe(T0 + LOCAL_ANALYSIS_DEADLINE_MS);
    expect(Date.parse(analysisDeadlineFor("claude", T0))).toBe(T0 + CLOUD_ANALYSIS_DEADLINE_MS);
  });
});

describe("analysisDeadlineMs", () => {
  it("prefers the stamped deadline", () => {
    const deadline = new Date(T0 + 42).toISOString();
    expect(analysisDeadlineMs({ deadline_at: deadline, started_at: "x" })).toBe(T0 + 42);
  });

  it("falls back to started_at, then created_at, plus the cloud allowance", () => {
    const iso = new Date(T0).toISOString();
    expect(analysisDeadlineMs({ started_at: iso })).toBe(T0 + CLOUD_ANALYSIS_DEADLINE_MS);
    expect(analysisDeadlineMs({}, iso)).toBe(T0 + CLOUD_ANALYSIS_DEADLINE_MS);
  });
});

describe("isAnalysisStale", () => {
  const notes = { deadline_at: new Date(T0).toISOString() };

  it("is false before the deadline and true after it", () => {
    expect(isAnalysisStale({ status: "processing", analysis_notes: notes }, T0 - 1)).toBe(false);
    expect(isAnalysisStale({ status: "processing", analysis_notes: notes }, T0 + 1)).toBe(true);
  });

  it("only applies to processing scans", () => {
    expect(isAnalysisStale({ status: "draft", analysis_notes: notes }, T0 + 1)).toBe(false);
    expect(isAnalysisStale({ status: "failed", analysis_notes: notes }, T0 + 1)).toBe(false);
  });

  it("keeps a long local run alive past the cloud allowance", () => {
    const local = { deadline_at: analysisDeadlineFor("ollama", T0) };
    const later = T0 + CLOUD_ANALYSIS_DEADLINE_MS * 2;
    expect(isAnalysisStale({ status: "processing", analysis_notes: local }, later)).toBe(false);
  });
});
