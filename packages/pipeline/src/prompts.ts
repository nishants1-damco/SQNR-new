// System prompts, read from the package's `prompts/` folder (the original app
// inlined them at build time with Vite's `?raw`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { PROMPT_VERSION } from "@spatial/domain/prompt-version";

export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export const PROMPT_NAMES = [
  "pass1-reconstruction",
  "pass2-critique",
  "object-inventory",
  "object-inventory-merge",
  "landmarks",
  "people-screener",
  "object-verification",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

const cache = new Map<PromptName, string>();

/** A prompt's text, trimmed. */
export function prompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(`${PROMPTS_DIR}${name}.md`, "utf8").trim();
    cache.set(name, text);
  }
  return text;
}
