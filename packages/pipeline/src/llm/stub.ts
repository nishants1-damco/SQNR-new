// A stand-in for Claude in load tests (plan §18.1): answers every pass with a
// plausible room after a realistic delay, sometimes refuses with a 429, and
// goes through the real LlmGate, so queueing, permits, backpressure and
// worker scaling can be tested without spending money. Enabled with
// LLM_STUB=true; the worker config refuses it in production.
import { recordCallMetrics } from "./claude";
import { estimateInputTokens } from "./content";
import { LlmError } from "./errors";
import type { LlmGate } from "./gate";
import { CLOUD_BUDGETS, type LlmProvider, type LlmRequest } from "./types";
import type { LlmCall } from "./usage";

export interface StubOptions {
  model: string;
  gate: LlmGate;
  /** Mean latency per call; each call waits 0.5x to 1.5x of it. */
  latencyMs: number;
  /** Fraction of calls answered with a 429. */
  rateLimitRate: number;
  random?: () => number;
}

const OBJECT = {
  label: "Desk",
  category: "table",
  confidence: 0.9,
  x_m: 0,
  y_m: 1.6,
  width_m: 1.4,
  depth_m: 0.7,
  height_m: 0.75,
  material: "wood",
  against_wall: "north",
  yaw_deg: 180,
  wall_offset_m: 1.75,
  supporting_headings_deg: [0],
  floor_elevation_m: 0,
  relative_to: null,
  spatial_relation: "none",
};

const ROOM = {
  name: "Load-test room",
  summary: "A synthetic room from the load-test model stub.",
  width_m: 3.5,
  length_m: 4,
  height_m: 2.5,
  scale_reference: "stub",
  dimension_confidence: { width: 0.5, length: 0.5, height: 0.5, overall: 0.5, basis: "stub" },
  wall_evidence: [],
  objects: [OBJECT],
  surfaces: [],
  portals: [
    {
      kind: "door",
      wall: "east",
      offset_m: 1,
      width_m: 0.9,
      height_m: 2.03,
      sill_m: 0,
      confidence: 0.9,
      notes: "",
    },
  ],
};

const REPLIES: Record<string, unknown> = {
  "people-screen": { frames_with_people: [] },
  inventory: { objects: [{ ...OBJECT, frame_boxes: [] }] },
  "inventory-batch": { objects: [{ ...OBJECT, frame_boxes: [] }] },
  "inventory-merge": { objects: [{ ...OBJECT, frame_boxes: [] }] },
  landmarks: { sightings: [] },
  verification: { verdicts: [] },
  reconstruction: ROOM,
  review: { ...ROOM, revision_notes: [] },
};

export class StubProvider implements LlmProvider {
  readonly kind = "claude" as const;
  readonly budgets = CLOUD_BUDGETS;
  readonly needsJsonInstructions = false;
  readonly primaryModel: string;
  readonly fallbackModel: string;

  constructor(private readonly options: StubOptions) {
    this.primaryModel = options.model;
    this.fallbackModel = options.model;
  }

  async complete(request: LlmRequest): Promise<string> {
    const random = this.options.random ?? Math.random;
    const inputTokens = estimateInputTokens(request.messages);
    const lease = await this.options.gate.acquire("claude", {
      inputTokens,
      outputTokens: 4000,
    });
    const started = Date.now();
    const call = (ok: boolean, output = 0): LlmCall => ({
      step: request.step,
      provider: "claude",
      model: request.model,
      served_model: request.model,
      ms: Date.now() - started,
      input_tokens: ok ? inputTokens : 0,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      stop_reason: ok ? "end_turn" : null,
      ok,
    });
    try {
      await new Promise((r) => setTimeout(r, this.options.latencyMs * (0.5 + random())));
      if (random() < this.options.rateLimitRate) {
        const failed = call(false);
        request.record?.(failed);
        recordCallMetrics(failed);
        await this.options.gate.penalize("claude");
        throw new LlmError("rate_limited", "AI rate limit reached. Try again in a moment.");
      }
      const done = call(true, 2000);
      request.record?.(done);
      recordCallMetrics(done);
      await lease.release({ inputTokens, outputTokens: done.output_tokens });
      return JSON.stringify(REPLIES[request.step] ?? {});
    } finally {
      await lease.release();
    }
  }
}
