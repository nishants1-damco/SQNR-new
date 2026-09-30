// A provider that answers from a script instead of a model: for tests and
// the eval harness's offline mode. Each reply is chosen by pipeline step.
import { CLOUD_BUDGETS, type FrameBudgets, type LlmProvider, type LlmRequest } from "./types";

export type ScriptedReply = unknown | ((request: LlmRequest) => unknown);

export class ScriptedProvider implements LlmProvider {
  readonly kind: "claude" | "ollama";
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly budgets: FrameBudgets;
  readonly needsJsonInstructions = false;
  /** Every request, in order, for assertions. */
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly replies: Record<string, ScriptedReply>,
    options: { kind?: "claude" | "ollama"; model?: string; budgets?: FrameBudgets } = {},
  ) {
    this.kind = options.kind ?? "claude";
    this.primaryModel = options.model ?? "scripted-model";
    this.fallbackModel = this.primaryModel;
    this.budgets = options.budgets ?? CLOUD_BUDGETS;
  }

  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const started = Date.now();
    const reply = this.replies[request.step];
    const finish = (ok: boolean) =>
      request.record?.({
        step: request.step,
        provider: this.kind,
        model: request.model,
        served_model: request.model,
        ms: Date.now() - started,
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        stop_reason: ok ? "end_turn" : null,
        ok,
      });
    try {
      if (reply === undefined) throw new Error(`No scripted reply for step "${request.step}"`);
      const value =
        typeof reply === "function" ? (reply as (r: LlmRequest) => unknown)(request) : reply;
      finish(true);
      return Promise.resolve(typeof value === "string" ? value : JSON.stringify(value));
    } catch (err) {
      finish(false);
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  steps(): string[] {
    return this.requests.map((r) => r.step);
  }
}
