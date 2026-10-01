// One analysis is one trace (plan §16.1): the API request that queues a job
// writes the trace context into the outbox payload, and the worker continues
// that trace when it runs the job. W3C trace context (`traceparent`).
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

export type TraceCarrier = Record<string, string>;

/** The current trace context, to store with work that runs later (empty when not tracing). */
export function currentTraceCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export const tracer = () => trace.getTracer("spatial");

/**
 * Runs `work` in a span. With a carrier (from `currentTraceCarrier` in another
 * process), the span continues that trace. Errors are recorded and rethrown.
 */
export async function inSpan<T>(
  name: string,
  work: (span: Span) => Promise<T>,
  options: { carrier?: TraceCarrier | undefined; attributes?: Attributes } = {},
): Promise<T> {
  const parent = options.carrier
    ? propagation.extract(context.active(), options.carrier)
    : context.active();
  return tracer().startActiveSpan(
    name,
    { attributes: options.attributes ?? {} },
    parent,
    async (span) => {
      try {
        return await work(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
