// The app's own metrics (plan §16.1), beside what the instrumentations record
// (HTTP latency per route, DB and Redis calls). Names follow OpenTelemetry
// conventions; alerts and dashboards (infra/azure, infra/docker/observability)
// refer to them by these names.
import { type Attributes, metrics, type ObservableResult } from "@opentelemetry/api";

const meter = () => metrics.getMeter("spatial");

let instruments: ReturnType<typeof create> | null = null;

function create() {
  const m = meter();
  return {
    analysisRuns: m.createCounter("spatial.analysis.runs", {
      description: "Analysis runs that ended, by outcome (succeeded, failed, skipped) and provider",
    }),
    analysisDuration: m.createHistogram("spatial.analysis.duration", {
      description: "Wall-clock time of a finished run attempt",
      unit: "s",
    }),
    stageDuration: m.createHistogram("spatial.analysis.stage.duration", {
      description: "Time spent in one analysis stage",
      unit: "s",
    }),
    queueWait: m.createHistogram("spatial.analysis.queue_wait", {
      description: "Time from queueing a run to a worker starting it",
      unit: "s",
    }),
    llmCalls: m.createCounter("spatial.llm.calls", {
      description: "Model calls, by model, step and outcome",
    }),
    llmTokens: m.createCounter("spatial.llm.tokens", {
      description: "Tokens by model and kind (input, output, cache_read, cache_write)",
      unit: "{token}",
    }),
    llmCost: m.createCounter("spatial.llm.cost", {
      description: "Estimated spend on model calls",
      unit: "{USD}",
    }),
    llmRateLimited: m.createCounter("spatial.llm.rate_limited", {
      description: "Model calls the provider refused with 429",
    }),
    quotaRejections: m.createCounter("spatial.quota.rejections", {
      description: "Requests refused by a quota, throttle, spend cap or backpressure",
    }),
    sseStreams: m.createUpDownCounter("spatial.sse.streams", {
      description: "Open analysis event streams on this replica",
    }),
    uploadFailures: m.createCounter("spatial.uploads.failures", {
      description: "Upload completions refused (missing blob, wrong type or size)",
    }),
  };
}

/** The app's instruments. No-ops until the SDK starts. */
export function appMetrics() {
  instruments ??= create();
  return instruments;
}

/** A gauge read on every export, e.g. queue depth from BullMQ. */
export function observeGauge(
  name: string,
  description: string,
  read: () => Promise<{ value: number; attributes?: Attributes }[]>,
): void {
  meter()
    .createObservableGauge(name, { description })
    .addCallback(async (result: ObservableResult) => {
      try {
        for (const { value, attributes } of await read()) result.observe(value, attributes);
      } catch {
        // A failed read skips this export; the next one tries again.
      }
    });
}
