// String hygiene for anything a VLM produced or a user typed. Two concerns:
//
//   1. VLM output sometimes contains HTML/Markdown-like formatting we never
//      asked for — writing that straight into `scans.ai_summary` and
//      rendering it downstream is an XSS path.
//   2. Free-text fields on user objects (`label`, `notes`) should have a
//      hard cap so a runaway prompt or paste doesn't wedge the UI.
//
// This is deliberately conservative: strip tags entirely, collapse HTML
// entities into their text equivalents, and trim to a max length. If a
// call site later needs Markdown, wrap and render explicitly rather than
// weakening the sanitizer.

const TAG_RE = /<\/?[^>]+>/g;
// Attributes that show up in prompt-injection attempts even without tags
// (e.g. "javascript:alert(1)" pasted into an object label).
const DANGEROUS_URL_RE = /\b(?:javascript|data|vbscript):[^\s]+/gi;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Strip HTML, decode common entities, collapse whitespace and trim to
 * `maxLength` characters. Returns "" for null/undefined.
 */
export function sanitizeText(input: string | null | undefined, maxLength = 2000): string {
  if (input == null) return "";
  let s = String(input).replace(TAG_RE, "");
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    s = s.split(entity).join(char);
  }
  s = s.replace(DANGEROUS_URL_RE, "[removed:url]");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLength) s = s.slice(0, maxLength - 1) + "…";
  return s;
}

/**
 * Sanitize each string value inside a JSON-safe object. Non-string values
 * are returned as-is. Recurses into objects and arrays.
 */
export function sanitizeDeep<T>(value: T, maxLength = 2000): T {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value, maxLength) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, maxLength)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v, maxLength);
    }
    return out as unknown as T;
  }
  return value;
}
