// Claude through the official Anthropic SDK and the native Messages API,
// ported from `src/llm/claude.server.ts`. The Opus 5.5 rules (plan §9.7.2)
// are enforced here so later changes can't break them:
//   - no `thinking` field (thinking is always on; `disabled` and
//     `budget_tokens` are rejected), no forced tool_choice, no prefill;
//   - an explicit effort on every call (the model's default is `medium`);
//   - streaming with a generous `max_tokens`, since thinking counts toward it;
//   - structured outputs for every JSON reply;
//   - server-side refusal fallbacks (`fallbacks: "default"`), recording which
//     model actually answered;
//   - one user turn per call.
// Every call also passes through the LlmGate (global permits and token
// buckets) and records its usage.
import Anthropic from "@anthropic-ai/sdk";
import { errString, type PipelineLogger, silentLogger } from "../logger";
import { estimateInputTokens, splitPipelineMessages, toClaudeContent } from "./content";
import { LlmError } from "./errors";
import type { LlmGate } from "./gate";
import { CLOUD_BUDGETS, type LlmProvider, type LlmRequest } from "./types";
import type { LlmCall } from "./usage";

/** Beta that enables `fallbacks` on the Messages API (not available on Batches). */
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Streaming, so a generous ceiling costs nothing unless it's used. */
const MAX_TOKENS = 64_000;
/** Output tokens reserved against OTPM before a call; settled afterwards. */
const OUTPUT_RESERVATION = 16_000;

export interface ClaudeProviderOptions {
  client: Anthropic;
  model: string;
  fallbackModel: string;
  gate: LlmGate;
  /** Opt into server-side refusal fallbacks (plan §9.7.2). */
  refusalFallbacks?: boolean;
  logger?: PipelineLogger;
}

type Message = Anthropic.Beta.BetaMessage;

/** The model that produced the reply: a `fallback_message` iteration names it. */
export function servedModel(message: Message, requested: string): string {
  const iterations = (message.usage as { iterations?: unknown }).iterations;
  if (Array.isArray(iterations)) {
    for (const it of iterations as { type?: unknown; model?: unknown }[]) {
      if (it.type === "fallback_message" && typeof it.model === "string") return it.model;
    }
  }
  return message.model || requested;
}

export class ClaudeProvider implements LlmProvider {
  readonly kind = "claude" as const;
  readonly budgets = CLOUD_BUDGETS;
  readonly needsJsonInstructions = false;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  private readonly logger: PipelineLogger;

  constructor(private readonly options: ClaudeProviderOptions) {
    this.primaryModel = options.model;
    this.fallbackModel = options.fallbackModel;
    this.logger = options.logger ?? silentLogger;
  }

  async complete(request: LlmRequest): Promise<string> {
    const { system, content } = splitPipelineMessages(request.messages);
    const fallbacks = this.options.refusalFallbacks ?? true;
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: toClaudeContent(content) }],
      output_config: {
        effort: request.effort ?? "high",
        ...(request.schema ? { format: { type: "json_schema", schema: request.schema } } : {}),
      },
      ...(fallbacks ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    const reservation = {
      inputTokens: estimateInputTokens(request.messages),
      outputTokens: OUTPUT_RESERVATION,
    };
    const lease = await this.options.gate.acquire("claude", reservation);
    const started = Date.now();
    const record = (message: Message | null, ok: boolean) => {
      const call: LlmCall = {
        step: request.step,
        provider: "claude",
        model: request.model,
        served_model: message ? servedModel(message, request.model) : request.model,
        ms: Date.now() - started,
        input_tokens: message?.usage.input_tokens ?? 0,
        output_tokens: message?.usage.output_tokens ?? 0,
        cache_read_input_tokens: message?.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: message?.usage.cache_creation_input_tokens ?? 0,
        stop_reason: message?.stop_reason ?? null,
        ok,
      };
      request.record?.(call);
      const fields = {
        step: call.step,
        model: call.served_model,
        ms: call.ms,
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        ...(call.cache_read_input_tokens ? { cache_read: call.cache_read_input_tokens } : {}),
        stop_reason: call.stop_reason,
      };
      if (ok) this.logger.info(fields, `${call.step} done`);
      else this.logger.warn(fields, `${call.step} failed`);
      return call;
    };

    let message: Message;
    try {
      message = await this.options.client.beta.messages.stream(params).finalMessage();
    } catch (err) {
      record(null, false);
      await lease.release({ inputTokens: 0, outputTokens: 0 });
      if (request.schema && err instanceof Anthropic.BadRequestError) {
        // Most likely the schema was rejected; the prompt still asks for JSON,
        // so run unconstrained rather than failing the analysis.
        this.logger.warn(
          { status: err.status, step: request.step },
          "structured output rejected; retrying without a schema",
        );
        return this.complete({ ...request, schema: undefined });
      }
      if (err instanceof Anthropic.RateLimitError) await this.options.gate.penalize("claude");
      throw this.friendlyError(err);
    }

    const call = record(
      message,
      message.stop_reason !== "refusal" && message.stop_reason !== "max_tokens",
    );
    await lease.release({
      inputTokens:
        call.input_tokens + call.cache_read_input_tokens + call.cache_creation_input_tokens,
      outputTokens: call.output_tokens,
    });

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? null;
      if (category === "reasoning_extraction") {
        // Not a false positive on room photos: a prompt is asking for the
        // model's reasoning in the reply. Fix the prompt (plan §9.7.2).
        this.logger.error(
          { step: request.step, category },
          "prompt triggered a reasoning_extraction refusal",
        );
      }
      throw new LlmError("refusal", "The AI provider declined to analyze these frames", {
        category,
      });
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmError("truncated", "The AI response was cut off before it finished");
    }
    return message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  /** Errors the caller knows how to react to (see LlmError). */
  private friendlyError(err: unknown): Error {
    if (err instanceof Anthropic.RateLimitError) {
      return new LlmError("rate_limited", "AI rate limit reached. Try again in a moment.");
    }
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      return new LlmError(
        "auth",
        "AI request rejected: check your cloud provider API key (ANTHROPIC_API_KEY).",
      );
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new LlmError("provider_unavailable", "AI analysis failed (network)");
    }
    if (err instanceof Anthropic.APIError) {
      this.logger.error({ status: err.status, err: errString(err) }, "claude request failed");
      const status = err.status ?? 0;
      return new LlmError(
        status >= 500 || status === 529 || status === 408
          ? "provider_unavailable"
          : "provider_rejected",
        `AI analysis failed (${status || "network"})`,
        { status },
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
