import { describe, expect, it } from "vitest";
import { sanitizeText, sanitizeDeep } from "./sanitize";

describe("sanitizeText", () => {
  it("returns empty string for null/undefined", () => {
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(undefined)).toBe("");
  });

  it("strips HTML tags", () => {
    expect(sanitizeText("<b>bold</b> and <script>alert(1)</script>")).toBe("bold and alert(1)");
  });

  it("decodes basic HTML entities", () => {
    expect(sanitizeText("&lt;b&gt;x&lt;/b&gt;")).toBe("<b>x</b>");
    expect(sanitizeText("R&amp;D")).toBe("R&D");
  });

  it("removes javascript: URLs even without tags", () => {
    expect(sanitizeText("click javascript:alert(1) here")).toBe("click [removed:url] here");
    expect(sanitizeText("data:text/html,<script>")).toBe("[removed:url]");
  });

  it("collapses whitespace", () => {
    expect(sanitizeText("a   b\n\tc")).toBe("a b c");
  });

  it("caps length with an ellipsis", () => {
    const s = "a".repeat(10);
    expect(sanitizeText(s, 5)).toBe("aaaa…");
    expect(sanitizeText(s, 5)).toHaveLength(5);
  });
});

describe("sanitizeDeep", () => {
  it("sanitizes strings inside a nested object", () => {
    const input = {
      label: "<b>Sofa</b>",
      material: "leather",
      dims: { note: "size: <em>large</em>" },
      tags: ["<i>couch</i>", "living"],
    };
    const out = sanitizeDeep(input);
    expect(out.label).toBe("Sofa");
    expect(out.dims.note).toBe("size: large");
    expect(out.tags).toEqual(["couch", "living"]);
  });

  it("leaves non-strings unchanged", () => {
    const input = { count: 3, ok: true, missing: null };
    expect(sanitizeDeep(input)).toEqual(input);
  });
});
