import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeProvider, REFUSAL_FALLBACK_BETA, servedModel } from "./claude";
import {
  estimateInputTokens,
  splitPipelineMessages,
  toClaudeContent,
  TOKENS_PER_IMAGE,
  withoutCacheMarkers,
} from "./content";
import { errorCode, isRetryable, LlmError, PipelineError } from "./errors";
import { openGate } from "./gate";
import {
  CRITIQUE_SCHEMA,
  LANDMARK_SCHEMA,
  OBJECT_INVENTORY_SCHEMA,
  PEOPLE_SCREENER_SCHEMA,
  RECONSTRUCTION_SCHEMA,
} from "./schemas";
import { CACHE_BREAKPOINT, type PipelineMessage } from "./types";
import { estimateCostUsd, type LlmCall, UsageTracker } from "./usage";

// ---- ported from src/lib/accuracy-pipeline.test.ts ----

describe("toClaudeContent", () => {
  it("converts text and data-URL images to Messages API blocks", () => {
    const out = toClaudeContent([
      { type: "text", text: "Frame 0 — heading 90°:" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/webp;base64,BBBB" } },
    ]);
    expect(out).toEqual([
      { type: "text", text: "Frame 0 — heading 90°:" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "BBBB" } },
    ]);
  });

  it("drops empty text, remote URLs and unsupported image types", () => {
    const out = toClaudeContent([
      { type: "text", text: "   " },
      { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
      { type: "image_url", image_url: { url: "data:image/svg+xml;base64,CCCC" } },
      { type: "unknown" },
    ]);
    expect(out).toEqual([]);
  });

  // New: the prompt-caching marker (plan §9.7.4).
  it("turns a cache breakpoint into cache_control on the block before it", () => {
    const out = toClaudeContent([
      { type: "text", text: "shared context" },
      CACHE_BREAKPOINT,
      { type: "text", text: "per-batch" },
    ]);
    expect(out).toEqual([
      { type: "text", text: "shared context", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per-batch" },
    ]);
    expect(toClaudeContent([CACHE_BREAKPOINT])).toEqual([]);
  });
});

describe("splitPipelineMessages", () => {
  it("separates the system prompt from the user content", () => {
    const { system, content } = splitPipelineMessages([
      { role: "system", content: "You detect objects." },
      { role: "user", content: [{ type: "text", text: "context" }] },
    ]);
    expect(system).toBe("You detect objects.");
    expect(content).toEqual([{ type: "text", text: "context" }]);
  });
});

describe("structured output schemas", () => {
  // Structured outputs require additionalProperties:false on every object, and
  // every property here is required (optional fields are nullable instead).
  const objectsIn = (schema: unknown): Record<string, unknown>[] => {
    if (!schema || typeof schema !== "object") return [];
    const s = schema as Record<string, unknown>;
    const own = s["type"] === "object" ? [s] : [];
    return [
      ...own,
      ...Object.values(s).flatMap((v) => (Array.isArray(v) ? v : [v]).flatMap(objectsIn)),
    ];
  };

  it.each([
    ["inventory", OBJECT_INVENTORY_SCHEMA],
    ["landmarks", LANDMARK_SCHEMA],
    ["people", PEOPLE_SCREENER_SCHEMA],
    ["reconstruction", RECONSTRUCTION_SCHEMA],
    ["critique", CRITIQUE_SCHEMA],
  ])("%s schema is closed and fully required", (_name, schema) => {
    const objects = objectsIn(schema);
    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      expect(o["additionalProperties"]).toBe(false);
      expect([...(o["required"] as string[])].sort()).toEqual(
        Object.keys(o["properties"] as object).sort(),
      );
    }
  });

  it("keeps unknown values distinguishable from zero", () => {
    const item = (
      OBJECT_INVENTORY_SCHEMA as {
        properties: { objects: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.objects.items.properties;
    expect(item["wall_offset_m"]).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
  });
});

// ---- ported from src/llm/usage.test.ts, with the plan §9.7.8 fixes ----

const call = (over: Partial<LlmCall>): LlmCall => ({
  step: "reconstruction",
  provider: "claude",
  model: "claude-opus-5-5",
  served_model: over.model ?? "claude-opus-5-5",
  ms: 1000,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  stop_reason: "end_turn",
  ok: true,
  ...over,
});

describe("estimateCostUsd", () => {
  it("prices input and output per model", () => {
    // Opus 5.5: $4 / $20 per million tokens.
    expect(estimateCostUsd([call({ input_tokens: 1_000_000, output_tokens: 100_000 })])).toBe(6);
    // Sonnet 5: $2 / $10.
    expect(estimateCostUsd([call({ model: "claude-sonnet-5", input_tokens: 500_000 })])).toBe(1);
  });

  it("bills Opus 5.5 cache reads at $0.20 per million (5% of input)", () => {
    expect(estimateCostUsd([call({ cache_read_input_tokens: 1_000_000 })])).toBe(0.2);
    // Other models keep the 10% factor.
    expect(
      estimateCostUsd([call({ model: "claude-sonnet-5", cache_read_input_tokens: 1_000_000 })]),
    ).toBe(0.2);
    // Cache writes bill at 125% of input.
    expect(estimateCostUsd([call({ cache_creation_input_tokens: 1_000_000 })])).toBe(5);
  });

  it("prices the model that actually answered", () => {
    expect(
      estimateCostUsd([call({ served_model: "claude-sonnet-5", input_tokens: 1_000_000 })]),
    ).toBe(2);
  });

  it("counts local calls as free instead of making the run's cost unknown", () => {
    expect(
      estimateCostUsd([
        call({ provider: "ollama", model: "qwen2.5vl-3b-48k", input_tokens: 10 }),
        call({ input_tokens: 1_000_000 }),
      ]),
    ).toBe(4);
  });

  it("returns null when a cloud model has no known price", () => {
    expect(estimateCostUsd([call({ model: "claude-unknown-9", input_tokens: 10 })])).toBeNull();
  });
});

describe("UsageTracker", () => {
  it("sums calls per step", () => {
    const t = new UsageTracker();
    t.record(call({ step: "inventory-batch", input_tokens: 100, output_tokens: 10, ms: 5 }));
    t.record(call({ step: "inventory-batch", input_tokens: 200, output_tokens: 20, ms: 7 }));
    t.record(call({ step: "review", input_tokens: 50, ok: false }));
    const s = t.summary();
    expect(s).toMatchObject({ calls: 3, failed_calls: 1, input_tokens: 350, output_tokens: 30 });
    expect(s.by_step["inventory-batch"]).toEqual({
      calls: 2,
      input_tokens: 300,
      output_tokens: 30,
      ms: 12,
    });
  });

  it("includes calls restored from an earlier attempt and counts fallback-served calls", () => {
    const t = new UsageTracker();
    t.record(call({ input_tokens: 5 }));
    t.restore([call({ input_tokens: 10, served_model: "claude-sonnet-5" })]);
    expect(t.summary()).toMatchObject({ calls: 2, input_tokens: 15, fallback_served: 1 });
  });
});

// ---- new: content helpers and errors ----

describe("estimateInputTokens", () => {
  it("counts images at the frame rate and text at ~4 characters a token", () => {
    const messages: PipelineMessage[] = [
      { role: "system", content: "x".repeat(400) },
      {
        role: "user",
        content: [
          { type: "text", text: "y".repeat(40) },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } },
        ],
      },
    ];
    expect(estimateInputTokens(messages)).toBe(TOKENS_PER_IMAGE + 110);
  });

  it("strips cache markers for providers that don't cache", () => {
    const [m] = withoutCacheMarkers([
      { role: "user", content: [{ type: "text", text: "a" }, CACHE_BREAKPOINT] },
    ]);
    expect(m?.content).toEqual([{ type: "text", text: "a" }]);
  });
});

describe("errors", () => {
  it("retries transient failures only", () => {
    expect(isRetryable(new LlmError("rate_limited", "x"))).toBe(true);
    expect(isRetryable(new LlmError("provider_unavailable", "x"))).toBe(true);
    expect(isRetryable(new LlmError("auth", "x"))).toBe(false);
    expect(isRetryable(new LlmError("refusal", "x"))).toBe(false);
    expect(isRetryable(new PipelineError("no_frames", "x"))).toBe(false);
    expect(isRetryable(new Error("connection reset"))).toBe(true);
    expect(errorCode(new PipelineError("no_frames", "x"))).toBe("no_frames");
    expect(errorCode(new Error("?"))).toBe("internal");
  });

  it("doesn't try another model for problems another model won't fix", () => {
    expect(new LlmError("rate_limited", "x").tryOtherModel).toBe(false);
    expect(new LlmError("local_unreachable", "x").tryOtherModel).toBe(false);
    expect(new LlmError("provider_unavailable", "x").tryOtherModel).toBe(true);
  });
});

// ---- new: ClaudeProvider request rules (plan §9.7.2) ----

type FakeMessage = Partial<Anthropic.Beta.BetaMessage> & { stop_details?: unknown };

function fakeClient(reply: FakeMessage | Error) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          sent.push(params);
          return {
            finalMessage: () =>
              reply instanceof Error
                ? Promise.reject(reply)
                : Promise.resolve({
                    model: "claude-opus-5-5",
                    stop_reason: "end_turn",
                    content: [{ type: "text", text: '{"ok":true}' }],
                    usage: {
                      input_tokens: 120,
                      output_tokens: 30,
                      cache_read_input_tokens: 0,
                      cache_creation_input_tokens: 0,
                    },
                    ...reply,
                  }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

const provider = (client: Anthropic) =>
  new ClaudeProvider({
    client,
    model: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5",
    gate: openGate,
  });

const request = {
  model: "claude-opus-5-5",
  step: "reconstruction",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ] as PipelineMessage[],
};

describe("ClaudeProvider", () => {
  it("sends effort, structured output and refusal fallbacks, and never thinking", async () => {
    const { client, sent } = fakeClient({});
    const calls: LlmCall[] = [];
    const text = await provider(client).complete({
      ...request,
      schema: { type: "object" },
      effort: "medium",
      record: (c) => calls.push(c),
    });
    expect(text).toBe('{"ok":true}');
    const params = sent[0]!;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      system: "sys",
      output_config: { effort: "medium", format: { type: "json_schema" } },
      betas: [REFUSAL_FALLBACK_BETA],
      fallbacks: "default",
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("temperature");
    expect(calls[0]).toMatchObject({
      ok: true,
      input_tokens: 120,
      served_model: "claude-opus-5-5",
    });
  });

  it("defaults to high effort", async () => {
    const { client, sent } = fakeClient({});
    await provider(client).complete(request);
    expect(sent[0]).toMatchObject({ output_config: { effort: "high" } });
  });

  it("records the fallback model that answered a refused request", async () => {
    const message = {
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          { type: "message", model: "claude-opus-5-5" },
          { type: "fallback_message", model: "claude-sonnet-5" },
        ],
      },
    } as unknown as Anthropic.Beta.BetaMessage;
    expect(servedModel(message, "claude-opus-5-5")).toBe("claude-sonnet-5");
  });

  it("turns a refusal and a cut-off reply into non-retryable errors", async () => {
    const refused = fakeClient({
      stop_reason: "refusal",
      stop_details: { category: "cyber", explanation: null },
    } as FakeMessage);
    await expect(provider(refused.client).complete(request)).rejects.toMatchObject({
      code: "refusal",
      retryable: false,
      details: { category: "cyber" },
    });
    const cut = fakeClient({ stop_reason: "max_tokens" });
    await expect(provider(cut.client).complete(request)).rejects.toMatchObject({
      code: "truncated",
    });
  });
});
