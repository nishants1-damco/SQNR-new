// The model boundary (migration plan §9.7.1). The pipeline builds
// OpenAI-style messages (a system string plus text and data-URL image blocks),
// which the local provider sends as they are and ClaudeProvider converts to
// the Messages API. A run picks its provider once and keeps it: results,
// frame budgets and deadlines differ between providers.
import type { LlmCall } from "./usage";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Stored on `scans.provider` / `scan_analyses.provider`. "ollama" is the
 * local open-source provider; the name is kept from the original app so
 * existing rows and deadlines (analysis-deadline.ts) keep their meaning.
 */
export type ProviderKind = "claude" | "ollama";

/** OpenAI-style content block: `{type:"text",text}` or `{type:"image_url",image_url:{url}}`. */
export type PipelineBlock = Record<string, unknown>;

export interface PipelineMessage {
  role: "system" | "user";
  content: string | PipelineBlock[];
}

/**
 * Marks the end of a prefix shared by several calls (plan §9.7.4).
 * ClaudeProvider turns it into `cache_control` on the block before it; the
 * local provider drops it.
 */
export const CACHE_BREAKPOINT: PipelineBlock = { type: "cache_breakpoint" };

export interface LlmRequest {
  model: string;
  messages: PipelineMessage[];
  /** JSON schema for structured output; omit for free-form text. */
  schema?: Record<string, unknown> | undefined;
  effort?: Effort | undefined;
  /** Pipeline step, for logs and per-run usage (e.g. "reconstruction"). */
  step: string;
  /** Receives one record per model call, failed ones included. */
  record?: ((call: LlmCall) => void) | undefined;
}

/** How many frames a run may send (plan §9.7.7: local models get far fewer). */
export interface FrameBudgets {
  maxFrames: number;
  /** Frames from the center viewpoint of a multi-viewpoint capture. */
  centerFrames: number;
  /** Frames from each corner viewpoint. */
  cornerFrames: number;
  /** Whether a corner keeps its downward ("low") view on top of its budget. */
  cornerLowView: boolean;
  /** Per-viewpoint detection batches (several image-heavy calls) are worth it. */
  batchDetection: boolean;
  /** Extra image calls: zoom-in verification and catalog reference photos. */
  extraImageCalls: boolean;
}

/** The original app's cloud budgets (`MAX_FRAMES = 40`, 16 center, 4 per corner). */
export const CLOUD_BUDGETS: FrameBudgets = {
  maxFrames: 40,
  centerFrames: 16,
  cornerFrames: 4,
  cornerLowView: true,
  batchDetection: true,
  extraImageCalls: true,
};

/** `LOCAL_MAX_FRAMES` and friends: CPU-bound inference can't hold more image tokens. */
export const LOCAL_BUDGETS: FrameBudgets = {
  maxFrames: 14,
  centerFrames: 8,
  cornerFrames: 2,
  cornerLowView: false,
  batchDetection: false,
  extraImageCalls: false,
};

export interface LlmProvider {
  readonly kind: ProviderKind;
  /** Model used for every pass. */
  readonly primaryModel: string;
  /** Model the reconstruction retries on after a primary-model failure. */
  readonly fallbackModel: string;
  readonly budgets: FrameBudgets;
  /** Whether prompts need the JSON-format instructions (no structured outputs). */
  readonly needsJsonInstructions: boolean;
  /** Returns the reply text. Throws LlmError for failures callers react to. */
  complete(request: LlmRequest): Promise<string>;
}
