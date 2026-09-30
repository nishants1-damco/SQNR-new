// Model provider settings shared by the API (which picks a run's provider and
// model when it queues it) and the worker (which runs it). Plan §9.7.
//
// Decisions: Claude through Anthropic's own API (D11); local open-source
// models in development and CI only (D12), so production refuses them.
import { z } from "zod";

export const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

export const LlmEnvSchema = z.object({
  /** Provider for runs that don't ask for one. Always `claude` in production. */
  LLM_DEFAULT_PROVIDER: z.enum(["claude", "ollama"]).default("claude"),
  /** Local models (Ollama): on by default outside production, never in production. */
  LLM_LOCAL_ENABLED: booleanString.optional(),
  /** OpenAI-compatible base URL of the local model server. */
  LLM_LOCAL_BASE_URL: z.url().optional(),
  LLM_LOCAL_MODEL: z.string().min(1).default("qwen2.5vl-3b-48k"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
  /** Retried on availability failures (overload, 5xx) of the reconstruction pass. */
  ANTHROPIC_FALLBACK_MODEL: z.string().min(1).default("claude-sonnet-5"),
  /** Server-side refusal fallbacks (`fallbacks: "default"`), plan §9.7.2. */
  ANTHROPIC_REFUSAL_FALLBACKS: booleanString.default(true),
});

export type LlmEnv = z.infer<typeof LlmEnvSchema>;

export interface LlmModelsConfig {
  defaultProvider: "claude" | "ollama";
  models: { claude: string; ollama: string };
  localEnabled: boolean;
}

/** Problems with the LLM settings for this environment (empty when fine). */
export function llmConfigProblems(e: LlmEnv, production: boolean): string[] {
  const problems: string[] = [];
  if (production && e.LLM_LOCAL_ENABLED) {
    problems.push("LLM_LOCAL_ENABLED: local models are development-only (D12)");
  }
  if (production && e.LLM_DEFAULT_PROVIDER !== "claude") {
    problems.push("LLM_DEFAULT_PROVIDER: must be claude in production (D12)");
  }
  const localEnabled = e.LLM_LOCAL_ENABLED ?? !production;
  if (!localEnabled && e.LLM_DEFAULT_PROVIDER === "ollama") {
    problems.push("LLM_DEFAULT_PROVIDER: ollama needs LLM_LOCAL_ENABLED=true");
  }
  return problems;
}

export function llmModels(e: LlmEnv, production: boolean): LlmModelsConfig {
  return {
    defaultProvider: e.LLM_DEFAULT_PROVIDER,
    models: { claude: e.ANTHROPIC_MODEL, ollama: e.LLM_LOCAL_MODEL },
    localEnabled: e.LLM_LOCAL_ENABLED ?? !production,
  };
}
