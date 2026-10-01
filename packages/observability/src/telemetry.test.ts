import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appMetrics } from "./metrics";
import { currentTraceCarrier, inSpan } from "./propagation";
import { startTelemetry, type Telemetry, telemetryConfigured } from "./telemetry";

const spans = new InMemorySpanExporter();
// Export waits for the SDK's (async) resource detection, so tests flush first.
const processor = new SimpleSpanProcessor(spans);
const finished = async () => {
  await processor.forceFlush();
  return spans.getFinishedSpans();
};
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
let telemetry: Telemetry;

beforeAll(() => {
  telemetry = startTelemetry({
    serviceName: "spatial-test",
    spanProcessor: processor,
    metricReader: reader,
  });
});

afterAll(async () => {
  await telemetry.shutdown();
});

describe("startTelemetry", () => {
  it("stays off unless an OTLP endpoint is configured", () => {
    expect(telemetryConfigured({})).toBe(false);
    expect(telemetryConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(
      true,
    );
    expect(
      telemetryConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_SDK_DISABLED: "true",
      }),
    ).toBe(false);
    expect(startTelemetry({ serviceName: "x", env: {} }).enabled).toBe(false);
  });
});

describe("trace propagation through jobs", () => {
  it("continues the queuing request's trace in the job's span", async () => {
    let carrier: Record<string, string> = {};
    let requestTraceId = "";
    await inSpan("POST /v1/scans/:id/analysis", async (span) => {
      requestTraceId = span.spanContext().traceId;
      carrier = currentTraceCarrier();
    });
    expect(carrier["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // Later, in the worker:
    await inSpan("job analysis-cloud", async () => undefined, { carrier });
    const job = (await finished()).find((s) => s.name === "job analysis-cloud");
    expect(job?.spanContext().traceId).toBe(requestTraceId);
  });

  it("records a failure on the span and rethrows it", async () => {
    await expect(
      inSpan("analysis.pass1", async () => {
        throw new Error("AI analysis failed (529)");
      }),
    ).rejects.toThrow("529");
    const span = (await finished()).find((s) => s.name === "analysis.pass1");
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("app metrics", () => {
  it("exports the analysis and model instruments", async () => {
    const m = appMetrics();
    m.analysisRuns.add(1, { provider: "claude", outcome: "succeeded" });
    m.llmTokens.add(1200, { model: "claude-opus-5-5", step: "reconstruction", kind: "input" });
    m.llmCost.add(0.05, { model: "claude-opus-5-5", step: "reconstruction" });
    await reader.forceFlush();
    const names = metricExporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics.map((x) => x.descriptor.name)));
    expect(names).toEqual(
      expect.arrayContaining(["spatial.analysis.runs", "spatial.llm.tokens", "spatial.llm.cost"]),
    );
  });
});
