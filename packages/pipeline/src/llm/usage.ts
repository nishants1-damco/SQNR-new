// Per-run record of model calls: which step, which model, how long, how many
// tokens. Summed into `scan_analyses` (token and cost columns, plus a per-step
// breakdown in `metrics`) so the real cost of a scan is measured, not guessed.
//
// Ported from `src/llm/usage.ts` with the plan §9.7.8 fixes: cache reads are
// priced per model (Opus 5.5 bills them at 5% of input, not 10%), and local
// calls cost nothing instead of making the whole run's cost unknown.

export interface LlmCall {
  /** Pipeline step, e.g. "inventory-batch", "reconstruction", "verification". */
  step: string;
  provider: "claude" | "ollama";
  /** The model the request asked for. */
  model: string;
  /** The model that produced the reply: differs after a server-side refusal fallback. */
  served_model: string;
  ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  stop_reason: string | null;
  ok: boolean;
}

interface Price {
  /** USD per million input tokens. */
  input: number;
  output: number;
  /** USD per million cache-read tokens. */
  cacheRead: number;
  /** USD per million cache-write tokens (5-minute TTL). */
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

/** List prices. Update when prices change; longer ids first so prefixes match correctly. */
const PRICES: [prefix: string, price: Price][] = [
  ["claude-opus-5-5", price(4, 20, 0.2)],
  ["claude-opus-5", price(5, 25)],
  ["claude-sonnet-5", price(2, 10)],
  ["claude-haiku-4-5", price(1, 5)],
];

function priceFor(model: string): Price | null {
  return PRICES.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))?.[1] ?? null;
}

/**
 * Estimated USD cost of the calls. Local calls cost nothing here (they run
 * on our own hardware); null only if a cloud call used a model without a price.
 */
export function estimateCostUsd(calls: LlmCall[]): number | null {
  let total = 0;
  for (const c of calls) {
    if (c.provider === "ollama") continue;
    const p = priceFor(c.served_model || c.model);
    if (!p) return null;
    total +=
      (c.input_tokens * p.input +
        c.cache_read_input_tokens * p.cacheRead +
        c.cache_creation_input_tokens * p.cacheWrite +
        c.output_tokens * p.output) /
      1_000_000;
  }
  return Math.round(total * 10000) / 10000;
}

export interface UsageSummary {
  calls: number;
  failed_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  estimated_cost_usd: number | null;
  /** Calls a server-side fallback model answered (plan §9.7.2). */
  fallback_served: number;
  by_step: Record<
    string,
    { calls: number; input_tokens: number; output_tokens: number; ms: number }
  >;
}

export class UsageTracker {
  readonly calls: LlmCall[] = [];
  readonly startedAt = Date.now();

  record(call: LlmCall): void {
    this.calls.push(call);
  }

  /** Adds calls recorded by an earlier attempt of the same run (from its checkpoints). */
  restore(calls: LlmCall[]): void {
    this.calls.unshift(...calls);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  summary(): UsageSummary {
    const by_step: UsageSummary["by_step"] = {};
    for (const c of this.calls) {
      const s = (by_step[c.step] ??= { calls: 0, input_tokens: 0, output_tokens: 0, ms: 0 });
      s.calls += 1;
      s.input_tokens += c.input_tokens;
      s.output_tokens += c.output_tokens;
      s.ms += c.ms;
    }
    const sum = (
      key:
        | "input_tokens"
        | "output_tokens"
        | "cache_read_input_tokens"
        | "cache_creation_input_tokens",
    ) => this.calls.reduce((t, c) => t + c[key], 0);
    return {
      calls: this.calls.length,
      failed_calls: this.calls.filter((c) => !c.ok).length,
      input_tokens: sum("input_tokens"),
      output_tokens: sum("output_tokens"),
      cache_read_input_tokens: sum("cache_read_input_tokens"),
      cache_creation_input_tokens: sum("cache_creation_input_tokens"),
      estimated_cost_usd: estimateCostUsd(this.calls),
      fallback_served: this.calls.filter((c) => c.ok && c.served_model !== c.model).length,
      by_step,
    };
  }
}
