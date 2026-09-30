// Recording and replaying model replies, so a capture recorded once against
// Claude (or a local model) can be re-run in CI for free. Replay checks that
// everything around the model (sampling, prompts' context, graph solve,
// constraints, persistence) still produces the same room.
import { createHash } from "node:crypto";
import type { LlmProvider, LlmRequest } from "@spatial/pipeline";
import type { Replies } from "./fixtures";

/** Hash of a request's text (not its images): which call of a step this is. */
export function requestTextHash(request: LlmRequest): string {
  const text = request.messages
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.map((b) => (typeof b["text"] === "string" ? b["text"] : "")),
    )
    .join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Wraps a real provider and keeps every reply. */
export class RecordingProvider implements LlmProvider {
  readonly replies: Replies = {};

  constructor(private readonly inner: LlmProvider) {}

  get kind() {
    return this.inner.kind;
  }
  get primaryModel() {
    return this.inner.primaryModel;
  }
  get fallbackModel() {
    return this.inner.fallbackModel;
  }
  get budgets() {
    return this.inner.budgets;
  }
  get needsJsonInstructions() {
    return this.inner.needsJsonInstructions;
  }

  async complete(request: LlmRequest): Promise<string> {
    const reply = await this.inner.complete(request);
    (this.replies[request.step] ??= []).push({ textHash: requestTextHash(request), reply });
    return reply;
  }
}

/**
 * Answers from recorded replies: the one recorded for the same request text,
 * else the next unused one for the step. `drift` counts the fallbacks, which
 * mean the context sent to the model changed since the recording.
 */
export class ReplayProvider implements LlmProvider {
  readonly needsJsonInstructions = false;
  drift = 0;
  private readonly used = new Map<string, Set<number>>();

  constructor(
    private readonly replies: Replies,
    private readonly base: Pick<LlmProvider, "kind" | "primaryModel" | "fallbackModel" | "budgets">,
  ) {}

  get kind() {
    return this.base.kind;
  }
  get primaryModel() {
    return this.base.primaryModel;
  }
  get fallbackModel() {
    return this.base.fallbackModel;
  }
  get budgets() {
    return this.base.budgets;
  }

  complete(request: LlmRequest): Promise<string> {
    const list = this.replies[request.step] ?? [];
    const used = this.used.get(request.step) ?? new Set<number>();
    this.used.set(request.step, used);
    const hash = requestTextHash(request);
    let index = list.findIndex((r, i) => !used.has(i) && r.textHash === hash);
    if (index === -1) {
      index = list.findIndex((_, i) => !used.has(i));
      if (index !== -1 && list[index]?.textHash) this.drift++;
    }
    request.record?.({
      step: request.step,
      provider: this.kind,
      model: request.model,
      served_model: request.model,
      ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      stop_reason: index === -1 ? null : "end_turn",
      ok: index !== -1,
    });
    if (index === -1) {
      return Promise.reject(new Error(`No recorded reply left for step "${request.step}"`));
    }
    used.add(index);
    return Promise.resolve(list[index]!.reply);
  }
}
