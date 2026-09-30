// A local open-source vision model behind an OpenAI-compatible
// `/chat/completions` endpoint (Ollama serving Qwen2.5-VL in development),
// streamed. Ported from `callOllama` in `src/lib/scan-analysis.server.ts`.
// Development and CI only (decision D12).
import { withoutCacheMarkers, estimateInputTokens } from "./content";
import { LlmError } from "./errors";
import type { LlmGate } from "./gate";
import { LOCAL_BUDGETS, type LlmProvider, type LlmRequest } from "./types";

export interface LocalProviderOptions {
  /** e.g. `http://127.0.0.1:11434/v1` */
  baseUrl: string;
  model: string;
  gate: LlmGate;
  fetch?: typeof fetch;
}

export class LocalOpenAICompatProvider implements LlmProvider {
  readonly kind = "ollama" as const;
  readonly budgets = LOCAL_BUDGETS;
  /** No structured outputs: the prompts carry the JSON format instead. */
  readonly needsJsonInstructions = true;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  private readonly url: string;

  constructor(private readonly options: LocalProviderOptions) {
    this.primaryModel = options.model;
    this.fallbackModel = options.model;
    this.url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  async complete(request: LlmRequest): Promise<string> {
    const lease = await this.options.gate.acquire("ollama", {
      inputTokens: estimateInputTokens(request.messages),
      outputTokens: 0,
    });
    const started = Date.now();
    const record = (ok: boolean) =>
      request.record?.({
        step: request.step,
        provider: "ollama",
        model: request.model,
        served_model: request.model,
        ms: Date.now() - started,
        // The local stream doesn't report token usage.
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        stop_reason: null,
        ok,
      });
    try {
      const content = await this.stream(request);
      record(true);
      return content;
    } catch (err) {
      record(false);
      throw err;
    } finally {
      await lease.release();
    }
  }

  private async stream(request: LlmRequest): Promise<string> {
    // Ollama ignores the Authorization header, so none is sent: a cloud API
    // key never leaks into local requests.
    const body = {
      model: request.model,
      messages: withoutCacheMarkers(request.messages),
      stream: true,
      response_format: { type: "json_object" },
    };

    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A network-level failure almost always means the daemon isn't running.
      throw new LlmError(
        "local_unreachable",
        `Local LLM unreachable at ${this.url}. Start it with \`pnpm infra:llm\` and confirm the model exists (\`pnpm infra:llm:models\`). Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 429) {
      throw new LlmError("rate_limited", "AI rate limit reached. Try again in a moment.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        "auth",
        "Local LLM rejected the request. Is the Ollama container running?",
      );
    }
    if (res.status === 404) {
      throw new LlmError(
        "local_unreachable",
        `Local LLM has no model "${request.model}". Create it with \`pnpm infra:llm:models\`.`,
      );
    }
    if (!res.ok) {
      throw new LlmError(
        res.status >= 500 ? "provider_unavailable" : "provider_rejected",
        `AI analysis failed (${res.status}): ${(await res.text()).slice(0, 500)}`,
      );
    }
    if (!res.body)
      throw new LlmError("provider_unavailable", "AI analysis returned no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          content += chunk.choices?.[0]?.delta?.content ?? "";
        } catch {
          // A partial JSON line: the next chunk completes it.
        }
      }
    }
    return content;
  }
}
