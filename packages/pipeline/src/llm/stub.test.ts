import { describe, expect, it } from "vitest";
import { LlmError } from "./errors";
import { openGate } from "./gate";
import {
  CRITIQUE_SCHEMA,
  LANDMARK_SCHEMA,
  OBJECT_INVENTORY_SCHEMA,
  PEOPLE_SCREENER_SCHEMA,
  RECONSTRUCTION_SCHEMA,
  VERIFICATION_SCHEMA,
} from "./schemas";
import { StubProvider } from "./stub";
import type { LlmCall } from "./usage";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
};

/** Required keys present and types right, all the way down: enough to trust a canned reply. */
function conforms(value: unknown, schema: Schema, path = "$"): string[] {
  if (schema.anyOf) {
    return schema.anyOf.some((s) => conforms(value, s, path).length === 0)
      ? []
      : [`${path}: matches no branch`];
  }
  const types = [schema.type ?? []].flat();
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const ok =
    types.length === 0 ||
    types.some((t) => t === actual || (t === "integer" && actual === "number"));
  if (!ok) return [`${path}: ${actual} is not ${types.join("|")}`];
  if (actual === "array" && schema.items) {
    return (value as unknown[]).flatMap((v, i) => conforms(v, schema.items!, `${path}[${i}]`));
  }
  if (actual === "object" && schema.properties) {
    const o = value as Record<string, unknown>;
    return [
      ...(schema.required ?? []).filter((k) => !(k in o)).map((k) => `${path}.${k}: missing`),
      ...Object.entries(o).flatMap(([k, v]) =>
        schema.properties![k]
          ? conforms(v, schema.properties![k], `${path}.${k}`)
          : [`${path}.${k}: unknown`],
      ),
    ];
  }
  return [];
}

const request = (step: string, record?: (call: LlmCall) => void) => ({
  step,
  model: "claude-opus-5-5",
  messages: [{ role: "user" as const, content: "load test" }],
  schema: {},
  effort: "medium" as const,
  record,
});

describe("StubProvider", () => {
  it.each([
    ["people-screen", PEOPLE_SCREENER_SCHEMA],
    ["inventory", OBJECT_INVENTORY_SCHEMA],
    ["inventory-merge", OBJECT_INVENTORY_SCHEMA],
    ["landmarks", LANDMARK_SCHEMA],
    ["verification", VERIFICATION_SCHEMA],
    ["reconstruction", RECONSTRUCTION_SCHEMA],
    ["review", CRITIQUE_SCHEMA],
  ])("answers %s with a reply that fits its schema", async (step, schema) => {
    const stub = new StubProvider({ model: "m", gate: openGate, latencyMs: 0, rateLimitRate: 0 });
    const calls: LlmCall[] = [];
    const reply = JSON.parse(await stub.complete(request(step, (c) => calls.push(c)) as never));
    expect(conforms(reply, schema as Schema)).toEqual([]);
    expect(calls).toMatchObject([{ step, ok: true, output_tokens: 2000 }]);
  });

  it("answers some calls with a rate limit, and tells the gate", async () => {
    let penalized = 0;
    const gate = { ...openGate, penalize: () => Promise.resolve(void penalized++) };
    const stub = new StubProvider({ model: "m", gate, latencyMs: 0, rateLimitRate: 1 });
    const failure = await stub.complete(request("inventory") as never).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).code).toBe("rate_limited");
    expect(penalized).toBe(1);
  });
});
