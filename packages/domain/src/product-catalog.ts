// Product catalog matching — the pure half of the original
// `src/lib/product-catalog.ts`. When the VLM says "TV, 200 cm wide" but the
// label text says "55-inch TV", the catalog's reference dimension corrects
// the width before persisting.
//
// Deliberately narrow: a diagonal-inches parser for screens and fans, plus a
// category-aware match on distinctive label words (brand, model, "bathroom",
// "queen"). Not a full ontology. When in doubt it returns null — keeping the
// VLM's estimate is always safer than resizing an object to the wrong product.
//
// Fetching catalog rows, vector retrieval and image download are I/O and move
// to packages/pipeline in phase 3; they call `pickProductMatch` with the rows
// they load.

export interface ProductDimension {
  id: string;
  category: string;
  label: string;
  brand: string | null;
  model: string | null;
  width_m: number | null;
  height_m: number | null;
  depth_m: number | null;
  diagonal_in: number | null;
  aspect_ratio: string | null;
}

/** A catalog row returned by vector retrieval (`match_product_catalog`). */
export interface CatalogMatch {
  id: string;
  category: string;
  label: string;
  brand: string | null;
  model: string | null;
  classification: string | null;
  image_url: string | null;
  specs: Record<string, unknown> | null;
  width_m: number | null;
  height_m: number | null;
  depth_m: number | null;
  diagonal_in: number | null;
  aspect_ratio: string | null;
  similarity: number;
}

/**
 * Words that say what kind of thing an object is, or how it's measured, but
 * not which product it is. A label sharing only these with a catalog row
 * ("TV", "27-inch monitor", "door") is not evidence it's that product.
 */
const GENERIC_WORDS = new Set(
  [
    "a an and the of with for in on inch inches ft feet cm mm sweep size standard indian",
    "common tv television smart led lcd oled qled ips hd fhd uhd 4k monitor computer",
    "display screen door window ventilator fan ceiling bed wardrobe sofa seater table",
    "dining refrigerator fridge washing machine load ac unit indoor split ton geyser water",
    "heater storage",
  ]
    .join(" ")
    .split(" "),
);

/** Distinctive lowercase words of a label: no numbers, units or category nouns. */
function distinctiveTokens(text: string, category: string): Set<string> {
  const categoryWords = new Set(category.toLowerCase().split(/[_\s]+/));
  const tokens = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 2 || /^\d/.test(tok)) continue;
    if (GENERIC_WORDS.has(tok) || categoryWords.has(tok)) continue;
    tokens.add(tok);
  }
  return tokens;
}

/** Lowercase words of `text`, space-padded so phrases match on word boundaries. */
function wordText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * Screen devices whose VLM `category` varies ("television", "electronics",
 * "display"...). Checked against the label first, then the category.
 */
const DEVICE_CATEGORIES: { category: string; phrases: string[] }[] = [
  { category: "tv", phrases: ["tv", "television", "smart tv"] },
  {
    category: "monitor",
    phrases: ["monitor", "computer display", "desktop display", "pc display"],
  },
];

/** Furniture and accessories named after a device ("TV stand", "monitor arm"). */
const DEVICE_ACCESSORY_WORDS = [
  "stand",
  "console",
  "cabinet",
  "unit",
  "table",
  "mount",
  "bracket",
  "arm",
  "shelf",
  "credenza",
  "remote",
  "riser",
];

/**
 * Catalog category for a detected object. The VLM's `category` is free text,
 * while catalog rows use a fixed set ("tv", "monitor", "dining_table"...), so
 * a TV the model filed under "electronics" would otherwise never reach the
 * TV rows. Returns null when there's nothing to look up.
 */
export function catalogCategoryFor(category: string, label: string): string | null {
  const labelText = wordText(label);
  const categoryText = wordText(category);
  const deviceIn = (text: string) =>
    DEVICE_CATEGORIES.find((rule) => rule.phrases.some((p) => text.includes(` ${p} `)));
  const isAccessory = DEVICE_ACCESSORY_WORDS.some((w) => labelText.includes(` ${w} `));
  if (isAccessory) {
    // A "TV console" filed under `tv` must not be resized to a TV.
    if (deviceIn(categoryText)) return null;
  } else {
    const device = deviceIn(labelText) ?? deviceIn(categoryText);
    if (device) return device.category;
  }
  const normalized = categoryText.trim().replace(/ /g, "_");
  return normalized && normalized !== "other" ? normalized : null;
}

/**
 * Match a label like "55-inch OLED TV" or "bathroom door" to the best row of
 * one catalog category. `rows` must already be that category's slice, in the
 * order ties should break (the original query ordered by label). Returns null
 * when nothing plausibly fits or the match is ambiguous.
 */
export function pickProductMatch(
  rows: ProductDimension[],
  category: string,
  label: string,
): ProductDimension | null {
  if (rows.length === 0) return null;

  // Screens and fans: parse "<n>-inch", "<n>in" or "<n>\"" and pick the
  // nearest reference diagonal — same-size screens share a footprint.
  const inchMatch = label.match(/(\d{2,3})\s*(?:-|\s)?\s*(?:inch|in\b|")/i);
  if (inchMatch) {
    const wanted = Number(inchMatch[1]);
    let best: ProductDimension | null = null;
    let bestDelta = Infinity;
    for (const row of rows) {
      if (row.diagonal_in == null) continue;
      const delta = Math.abs(Number(row.diagonal_in) - wanted);
      if (delta < bestDelta) {
        best = row;
        bestDelta = delta;
      }
    }
    if (best && bestDelta <= 3) return best;
  }

  // Distinctive-word match: score rows by shared distinctive words and take
  // the best only if it's a unique winner.
  const wanted = distinctiveTokens(label, category);
  if (wanted.size === 0) return null;
  let best: ProductDimension | null = null;
  let bestScore = 0;
  let tied = false;
  for (const row of rows) {
    const have = distinctiveTokens(
      [row.label, row.brand, row.model].filter(Boolean).join(" "),
      category,
    );
    let score = 0;
    for (const tok of wanted) if (have.has(tok)) score++;
    if (score > bestScore) {
      best = row;
      bestScore = score;
      tied = false;
    } else if (score > 0 && score === bestScore) {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}

/** Render catalog matches as compact reference lines for a VLM prompt. */
export function formatCatalogContext(matches: CatalogMatch[]): string {
  if (matches.length === 0) return "";
  const lines = matches.map((m) => {
    const dims = [
      m.width_m != null ? `${m.width_m.toFixed(2)} m W` : null,
      m.height_m != null ? `${m.height_m.toFixed(2)} m H` : null,
      m.depth_m != null ? `${m.depth_m.toFixed(2)} m D` : null,
    ]
      .filter(Boolean)
      .join(" × ");
    const extra = [
      m.diagonal_in != null ? `${m.diagonal_in}"` : null,
      m.aspect_ratio ?? null,
      m.brand ? `brand ${m.brand}` : null,
      m.model ? `model ${m.model}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const kind = m.classification ?? m.category;
    return `- ${m.label} (${kind})${dims ? `: ${dims}` : ""}${extra ? `. ${extra}` : ""}`;
  });
  return `KNOWN REAL-DEVICE CATALOG — retrieved by visual/semantic similarity to items in this room. If a visible object is clearly one of these devices, use its catalog name and these exact real-world dimensions instead of estimating:\n${lines.join("\n")}`;
}

/** A catalog product's primary reference photo URL, if it has one. */
export function catalogImageUrl(m: Pick<CatalogMatch, "image_url" | "specs">): string | null {
  const specUrls = Array.isArray(m.specs?.["image_urls"])
    ? (m.specs["image_urls"] as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  return m.image_url ?? specUrls[0] ?? null;
}
