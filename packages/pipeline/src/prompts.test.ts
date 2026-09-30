// Ported from src/lib/prompt-inputs.test.ts ("prompts") and
// verification-and-capture.test.ts ("toCandidates").
import type { CatalogMatch } from "@spatial/domain/product-catalog";
import { describe, expect, it } from "vitest";
import { prompt, PROMPT_NAMES } from "./prompts";
import { toCandidates } from "./verification";

describe("prompts", () => {
  it("all load", () => {
    for (const name of PROMPT_NAMES) expect(prompt(name).length, name).toBeGreaterThan(50);
  });

  it("carry no single country's door sizes or demo-room examples", () => {
    for (const name of ["pass1-reconstruction", "pass2-critique"] as const) {
      const text = prompt(name);
      expect(text, name).not.toMatch(/0\.81|2\.03/);
      expect(text, name).toContain("REFERENCE SIZES");
      expect(text, name).not.toMatch(/piano bench|bench seen tucked into a piano/i);
      expect(text, name).not.toMatch(/archway, media grouping and bookcase/i);
    }
  });

  it("are country-neutral and free of pressure-caps headings", () => {
    for (const name of [
      "pass1-reconstruction",
      "pass2-critique",
      "object-inventory",
      "landmarks",
    ] as const) {
      const text = prompt(name);
      expect(text, name).not.toMatch(/India|United States|IS 1948/);
      expect(text, name).not.toMatch(/STRICT JSON|SCALE FIRST|THE SHELL IS THE PRIORITY/);
    }
  });

  it("don't hard-code the viewpoint count or tell the model to halve the room", () => {
    const text = prompt("pass1-reconstruction");
    expect(text).not.toMatch(/five discrete groups/i);
    expect(text).not.toMatch(/halve it/i);
  });

  // New: Opus 5.5 declines requests to reproduce its reasoning in the reply
  // (`reasoning_extraction`), so no prompt may ask for it (plan §9.7.2).
  it("never ask the model to write out its reasoning", () => {
    for (const name of PROMPT_NAMES) {
      expect(prompt(name), name).not.toMatch(
        /show your (reasoning|work|thinking)|think step by step|explain your reasoning/i,
      );
    }
  });
});

describe("toCandidates", () => {
  const row = (over: Partial<CatalogMatch>): CatalogMatch => ({
    id: "id",
    category: "tv",
    label: "label",
    brand: null,
    model: null,
    classification: null,
    image_url: null,
    specs: null,
    width_m: 1,
    height_m: 0.6,
    depth_m: 0.2,
    diagonal_in: null,
    aspect_ratio: null,
    similarity: 0.5,
    ...over,
  });

  it("keeps only specific products, once, and notes which have a photo", () => {
    const out = toCandidates([
      row({ id: "a", brand: "Xiaomi", image_url: "https://x.supabase.co/a.jpg" }),
      row({ id: "generic" }),
      row({ id: "a", brand: "Xiaomi" }),
      row({ id: "b", model: "GW2786TC", specs: { image_urls: [] } }),
    ]);
    expect(out.map((c) => [c.id, c.hasImage])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});
