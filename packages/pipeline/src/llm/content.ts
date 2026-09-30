// Conversion from pipeline messages to the Messages API, ported from
// `src/llm/claude.server.ts`, plus the cache breakpoint marker and the token
// estimate used for rate-limit reservations.
import type Anthropic from "@anthropic-ai/sdk";
import type { PipelineBlock, PipelineMessage } from "./types";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Convert pipeline blocks to Messages API blocks; unusable blocks are dropped. */
export function toClaudeContent(blocks: PipelineBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block["type"] === "cache_breakpoint") {
      const last = out[out.length - 1];
      if (last && (last.type === "text" || last.type === "image")) {
        last.cache_control = { type: "ephemeral" };
      }
      continue;
    }
    if (block["type"] === "text" && typeof block["text"] === "string") {
      if (block["text"].trim()) out.push({ type: "text", text: block["text"] });
      continue;
    }
    if (block["type"] === "image_url") {
      const url = (block["image_url"] as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string") continue;
      const comma = url.indexOf(",");
      const header = url.slice(0, comma); // e.g. "data:image/jpeg;base64"
      const mediaType = header.slice("data:".length).split(";")[0] as ImageType;
      if (!url.startsWith("data:") || comma < 0 || !header.endsWith(";base64")) continue;
      if (!IMAGE_TYPES.includes(mediaType)) continue;
      out.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: url.slice(comma + 1) },
      });
    }
  }
  return out;
}

/** Split `[{role:"system"}, {role:"user"}]` pipeline messages into system + content. */
export function splitPipelineMessages(messages: PipelineMessage[]): {
  system: string;
  content: PipelineBlock[];
} {
  const system: string[] = [];
  const content: PipelineBlock[] = [];
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") system.push(m.content);
    else if (m.role === "user") {
      if (typeof m.content === "string") content.push({ type: "text", text: m.content });
      else if (Array.isArray(m.content)) content.push(...m.content);
    }
  }
  return { system: system.join("\n\n"), content };
}

/** Pipeline messages without cache markers, for providers that don't cache. */
export function withoutCacheMarkers(messages: PipelineMessage[]): PipelineMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.filter((b) => b["type"] !== "cache_breakpoint") }
      : m,
  );
}

/** Tokens per 1920x1440 frame (plan §9.7.6). */
export const TOKENS_PER_IMAGE = 3700;

/** A conservative input-token estimate, for rate-limit reservations. */
export function estimateInputTokens(messages: PipelineMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b["type"] === "image_url") images++;
      else if (typeof b["text"] === "string") chars += b["text"].length;
    }
  }
  return images * TOKENS_PER_IMAGE + Math.ceil(chars / 4);
}
