// OpenTelemetry for the API and the worker (plan §16.1). Import-and-start
// before anything else loads (the instrumentations patch modules as they are
// required), which is why each app's main.ts imports its telemetry file first.
//
// Off unless an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT, or
// the per-signal variants) or an Application Insights connection string. In
// Azure, Container Apps' managed OpenTelemetry agent sets the OTLP endpoint and
// forwards traces to Application Insights; it doesn't forward metrics, so with
// APPLICATIONINSIGHTS_CONNECTION_STRING set, metrics go straight to Azure
// Monitor. Locally, point OTLP at the LGTM container (`pnpm infra:otel`). With the SDK off, the API calls in this
// package are no-ops, so instrumented code costs nothing.
import { AzureMonitorMetricExporter } from "@azure/monitor-opentelemetry-exporter";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { type MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceName: "spatial-api" | "spatial-worker" | (string & {});
  serviceVersion?: string;
  /** development | staging | production */
  environment?: string;
  env?: Record<string, string | undefined>;
  /** Tests: collect in memory instead of exporting. */
  spanProcessor?: SpanProcessor;
  metricReader?: MetricReader;
}

export interface Telemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

const disabled: Telemetry = { enabled: false, shutdown: () => Promise.resolve() };

export function telemetryConfigured(env: Record<string, string | undefined> = process.env) {
  if (env["OTEL_SDK_DISABLED"] === "true") return false;
  return Boolean(
    env["APPLICATIONINSIGHTS_CONNECTION_STRING"] ||
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] ||
    env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ||
    env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"],
  );
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const inMemory = Boolean(options.spanProcessor || options.metricReader);
  if (!inMemory && !telemetryConfigured(env)) return disabled;

  // Stable HTTP semantic conventions: `http.server.request.duration` in
  // seconds with the route template, which the dashboards and alerts use.
  process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] ??= "http";
  const worker = options.serviceName === "spatial-worker";
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
      "deployment.environment.name": options.environment ?? env["NODE_ENV"] ?? "development",
    }),
    // The API samples per OTEL_TRACES_SAMPLER / _ARG (a ratio in production;
    // everything by default). The worker keeps every job: few, long and the
    // traces most worth reading, even when the request that queued one wasn't sampled.
    ...(worker ? { sampler: new AlwaysOnSampler() } : {}),
    spanProcessors: [options.spanProcessor ?? new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReader:
      options.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: env["APPLICATIONINSIGHTS_CONNECTION_STRING"]
          ? new AzureMonitorMetricExporter({
              connectionString: env["APPLICATIONINSIGHTS_CONNECTION_STRING"],
            })
          : new OTLPMetricExporter(),
        exportIntervalMillis: Number(env["OTEL_METRIC_EXPORT_INTERVAL"] ?? 30_000),
      }),
    instrumentations: [
      new HttpInstrumentation({
        // Probes would drown out real traffic.
        ignoreIncomingRequestHook: (req) => /^\/health\//.test(req.url ?? ""),
      }),
      // A span per lifecycle hook (a dozen per request) halved API throughput
      // in load tests (plan §18.1); the request and handler spans remain.
      new FastifyOtelInstrumentation({ registerOnInitialization: true, instrumentHooks: false }),
      // The worker polls Postgres (outbox) and Redis (BullMQ) constantly:
      // record their calls only inside a request or job span.
      new PgInstrumentation({ requireParentSpan: worker }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      // The Anthropic SDK calls fetch (undici).
      new UndiciInstrumentation(),
      // Adds trace_id and span_id to every log line.
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
