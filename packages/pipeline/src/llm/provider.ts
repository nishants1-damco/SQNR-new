// Builds the provider a run asked for (plan §9.7.1). The worker keeps one
// Anthropic client and one gate for the process; providers are cheap.
import Anthropic from "@anthropic-ai/sdk";
import type { PipelineLogger } from "../logger";
import { ClaudeProvider } from "./claude";
import { LlmError } from "./errors";
import type { LlmGate } from "./gate";
import { LocalOpenAICompatProvider } from "./local";
import { StubProvider } from "./stub";
import type { LlmProvider, ProviderKind } from "./types";

export interface LlmSettings {
  anthropic: {
    apiKey: string | null;
    model: string;
    fallbackModel: string;
    refusalFallbacks: boolean;
  };
  local: {
    /** Development and CI only (D12); production workers never build one. */
    enabled: boolean;
    baseUrl: string;
    model: string;
  };
  /** Load tests: a stand-in for Claude (see stub.ts). Never in production. */
  stub?: { latencyMs: number; rateLimitRate: number } | null;
}

export class ProviderFactory {
  private client: Anthropic | null = null;

  constructor(
    private readonly settings: LlmSettings,
    private readonly gate: LlmGate,
    private readonly logger: PipelineLogger,
  ) {}

  /** A provider for one run. `model` is the one recorded on the run when it was queued. */
  create(kind: ProviderKind, model?: string): LlmProvider {
    if (kind === "ollama") {
      if (!this.settings.local.enabled) {
        throw new LlmError("provider_rejected", "Local models are disabled in this environment");
      }
      return new LocalOpenAICompatProvider({
        baseUrl: this.settings.local.baseUrl,
        model: model ?? this.settings.local.model,
        gate: this.gate,
      });
    }
    if (this.settings.stub) {
      return new StubProvider({
        model: model ?? this.settings.anthropic.model,
        gate: this.gate,
        ...this.settings.stub,
      });
    }
    const { apiKey } = this.settings.anthropic;
    if (!apiKey) {
      throw new LlmError(
        "auth",
        "AI request rejected: check your cloud provider API key (ANTHROPIC_API_KEY).",
      );
    }
    // SDK retries (2 by default) cover brief transient errors; longer outages
    // go through the job's retry with backoff, resuming from checkpoints.
    this.client ??= new Anthropic({ apiKey, maxRetries: 2 });
    return new ClaudeProvider({
      client: this.client,
      model: model ?? this.settings.anthropic.model,
      fallbackModel: this.settings.anthropic.fallbackModel,
      gate: this.gate,
      refusalFallbacks: this.settings.anthropic.refusalFallbacks,
      logger: this.logger,
    });
  }
}
