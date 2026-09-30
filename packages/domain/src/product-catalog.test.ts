// Ported from the original src/lib/product-catalog.test.ts. `matchProduct`
// fetched one category's rows ordered by label and matched in memory; the
// matching is now `pickProductMatch`, so the helper below reproduces that
// fetch over the in-memory fixture.
import { describe, expect, it } from "vitest";
import { catalogCategoryFor, pickProductMatch, type ProductDimension } from "./product-catalog";

function row(category: string, label: string, extra: Partial<ProductDimension> = {}) {
  return {
    id: label,
    category,
    label,
    brand: null,
    model: null,
    width_m: 1,
    height_m: 1,
    depth_m: 1,
    diagonal_in: null,
    aspect_ratio: null,
    ...extra,
  } satisfies ProductDimension;
}

const CATALOG: ProductDimension[] = [
  row("door", "Main door (Indian standard) 3ft x 7ft"),
  row("door", "Internal door (Indian standard) 2.5ft x 7ft"),
  row("door", "Bathroom door (Indian standard) 2ft x 7ft"),
  row("bed", "Queen bed (Indian standard) 5ft x 6.25ft"),
  row("bed", "King bed (Indian standard) 6ft x 6.25ft"),
  row("tv", "Xiaomi TV X Pro 43 QLED (43-inch 4K QLED television)", {
    brand: "Xiaomi",
    model: "ELA6002IN-L43MB-APIN",
    diagonal_in: 43,
  }),
  row("monitor", "BenQ GW2786TC 27-inch IPS monitor (27-inch FHD computer monitor)", {
    brand: "BenQ",
    model: "GW2786TC",
    diagonal_in: 27,
  }),
];

/** The rows `matchProduct` would have fetched: one category, ordered by label. */
const rowsFor = (category: string) =>
  CATALOG.filter((r) => r.category === category).sort((a, b) => (a.label < b.label ? -1 : 1));

const match = async (category: string, label: string) =>
  pickProductMatch(rowsFor(category), category, label)?.label ?? null;

describe("pickProductMatch", () => {
  it("does not resize a generic monitor or TV to a specific catalog device", async () => {
    expect(await match("monitor", "monitor")).toBeNull();
    expect(await match("monitor", "computer monitor")).toBeNull();
    expect(await match("tv", "TV")).toBeNull();
    expect(await match("tv", "flat screen tv on wall")).toBeNull();
    expect(await match("tv", "max x series tv")).toBeNull();
  });

  it("does not pick the first door for a bare 'door' label", async () => {
    expect(await match("door", "door")).toBeNull();
    expect(await match("door", "wooden door")).toBeNull();
  });

  it("matches on distinctive words", async () => {
    expect(await match("door", "bathroom door")).toMatch(/^Bathroom/);
    expect(await match("bed", "queen size bed")).toMatch(/^Queen/);
    expect(await match("monitor", "BenQ monitor")).toMatch(/^BenQ/);
    expect(await match("tv", "Xiaomi television")).toMatch(/^Xiaomi/);
  });

  it("matches screens by diagonal within 3 inches", async () => {
    expect(await match("tv", "43-inch TV")).toMatch(/^Xiaomi/);
    expect(await match("monitor", '27" monitor')).toMatch(/^BenQ/);
    expect(await match("tv", "65-inch TV")).toBeNull();
  });
});

describe("catalogCategoryFor", () => {
  it("maps free-text screen categories onto the catalog's", () => {
    expect(catalogCategoryFor("electronics", "Xiaomi 43-inch television")).toBe("tv");
    expect(catalogCategoryFor("television", "wall-mounted screen")).toBe("tv");
    expect(catalogCategoryFor("display", "BenQ computer monitor")).toBe("monitor");
    expect(catalogCategoryFor("electronics", "desktop display on desk")).toBe("monitor");
  });

  it("does not treat TV or monitor furniture as the device", () => {
    expect(catalogCategoryFor("furniture", "TV stand")).toBe("furniture");
    expect(catalogCategoryFor("tv", "55-inch TV console")).toBeNull();
    expect(catalogCategoryFor("storage", "tv cabinet")).toBe("storage");
    expect(catalogCategoryFor("other", "monitor arm")).toBeNull();
  });

  it("normalizes other categories to the catalog's snake_case", () => {
    expect(catalogCategoryFor("Dining Table", "six-seat table")).toBe("dining_table");
    expect(catalogCategoryFor("door", "bathroom door")).toBe("door");
    expect(catalogCategoryFor("other", "plant")).toBeNull();
    expect(catalogCategoryFor("", "")).toBeNull();
  });

  it("lets a stand-in device reach its catalog row whatever the model called it", async () => {
    const lookup = (category: string, label: string) => {
      const mapped = catalogCategoryFor(category, label);
      return mapped ? match(mapped, label) : Promise.resolve(null);
    };
    expect(await lookup("electronics", "Xiaomi television")).toMatch(/^Xiaomi/);
    expect(await lookup("electronics", "43 inch smart TV")).toMatch(/^Xiaomi/);
    expect(await lookup("display", "BenQ monitor")).toMatch(/^BenQ/);
    expect(await lookup("electronics", '27" computer monitor')).toMatch(/^BenQ/);
  });
});
