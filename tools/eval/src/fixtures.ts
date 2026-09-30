// Eval fixtures (plan §9.7.3, §18.1). Each `fixtures/<name>.json` is the
// hand-measured ground truth for one room. A fixture may also have a capture
// in `fixtures/<name>/`, which the harness runs through the real pipeline:
//
//   fixtures/<name>/capture.json         the scan's capture data and frame list
//   fixtures/<name>/frames/*.jpg         the frames (omit `file` to use a blank frame)
//   fixtures/<name>/replies.<provider>.json   model replies recorded with --record
//
// Files may contain comments: the original living-room-1.json had a comment
// header, which made `JSON.parse` throw and broke the whole eval.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Fixture {
  id: string;
  label: string;
  notes?: string;
  ground_truth: {
    width_m: number;
    length_m: number;
    height_m: number;
    objects?: { label: string; category: string; width_m: number }[];
    portals?: { kind: string; wall: string; width_m: number }[];
  };
  tolerance: { shell_m: number; object_width_m: number; portal_width_m: number };
}

export interface CapturePhoto {
  /** Relative to the capture's `frames/` folder; omitted for a blank synthetic frame. */
  file?: string;
  heading_deg: number | null;
  captured_at?: string;
  sensor_payload?: Record<string, unknown>;
}

export interface Capture {
  name: string;
  notes?: string | null;
  acoustics?: Record<string, unknown>;
  analysis_notes?: Record<string, unknown>;
  depth_metrics?: Record<string, unknown>;
  depth_source?: string | null;
  photos: CapturePhoto[];
}

/** Model replies by pipeline step, in call order; each has the hash of its request text. */
export type Replies = Record<string, { textHash?: string; reply: string }[]>;

export interface LoadedFixture {
  name: string;
  path: string;
  fixture: Fixture;
  /** Output written by something else (the original harness's `.actual.json`). */
  actual: Actual | null;
  capture: { dir: string; capture: Capture } | null;
}

export interface Actual {
  width_m?: number;
  length_m?: number;
  height_m?: number;
  objects?: { label?: string; category?: string; width_m?: number }[];
  portals?: { kind?: string; wall?: string; width_m?: number }[];
}

/** JSON with `//` and `/* *\/` comments, which are removed outside strings. */
export function parseJsonc<T>(text: string): T {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out) as T;
}

const readJsonc = <T>(path: string) => parseJsonc<T>(readFileSync(path, "utf8"));

export function loadFixtures(dir: string): LoadedFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".actual.json"))
    .sort()
    .map((file) => {
      const name = file.replace(/\.json$/, "");
      const path = join(dir, file);
      const actualPath = join(dir, `${name}.actual.json`);
      const captureDir = join(dir, name);
      const capturePath = join(captureDir, "capture.json");
      return {
        name,
        path,
        fixture: readJsonc<Fixture>(path),
        actual: existsSync(actualPath) ? readJsonc<Actual>(actualPath) : null,
        capture: existsSync(capturePath)
          ? { dir: captureDir, capture: readJsonc<Capture>(capturePath) }
          : null,
      };
    });
}

export function loadReplies(captureDir: string, provider: string): Replies | null {
  const path = join(captureDir, `replies.${provider}.json`);
  return existsSync(path) ? readJsonc<Replies>(path) : null;
}
