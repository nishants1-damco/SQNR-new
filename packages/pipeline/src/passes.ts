// The model passes of the reconstruction pipeline, ported from
// `src/lib/scan-analysis.server.ts`. The code body is the original; what
// changed on the way:
//   - Module-level provider constants (PROVIDER, PRIMARY_MODEL, LOCAL_*
//     budgets...) became per-run values from `ctx.provider`, so one worker can
//     run cloud and local analyses side by side (plan §9.7.1).
//   - Frames come from the BlobStore instead of Supabase Storage.
//   - Usage is recorded on the run's tracker instead of through
//     AsyncLocalStorage.
//   - Per-viewpoint detection batches mark their shared prefix for prompt
//     caching (plan §9.7.4).
//   - callWithFallback decides on LlmError.tryOtherModel instead of matching
//     message text.
import type { RawSighting } from "@spatial/domain/landmarks";
import { DEVICE_SCOPE_PROMPT } from "@spatial/domain/object-scope";
import { validateImageBytes, stripJpegExif } from "@spatial/domain/upload-validation";
import { isBetterFrame, selectCornerFrames } from "@spatial/domain/frame-selection";
import { isTrustedPose } from "@spatial/domain/sensor-trust";
import {
  batchViewpoints,
  mergeBatchInventories,
  type ViewpointFrame,
} from "@spatial/domain/inventory-merge";
import type { BlobStore } from "@spatial/storage";
import { errString, type PipelineLogger } from "./logger";
import { LlmError } from "./llm/errors";
import {
  CRITIQUE_SCHEMA,
  LANDMARK_SCHEMA,
  OBJECT_INVENTORY_SCHEMA as OBJECT_INVENTORY_JSON_SCHEMA,
  PEOPLE_SCREENER_SCHEMA,
  RECONSTRUCTION_SCHEMA,
} from "./llm/schemas";
import { CACHE_BREAKPOINT, type Effort, type LlmProvider, type PipelineMessage } from "./llm/types";
import type { UsageTracker } from "./llm/usage";
import { prompt } from "./prompts";
import type { AnalysisPhoto, AnalysisResult, ObjectInventoryResult } from "./types";

type Block = Record<string, unknown>;

/** Where each analysis frame came from, by frame number (see the frame captions). */
export interface FrameInfo {
  frame: number;
  station: number;
  heading_deg: number | null;
  fov_deg: number | null;
}

/** The analysis frames grouped by viewpoint (from `loadPhotoBlocks`). */
export interface PhotoViewpoints {
  /** Capture-protocol text shared by every batch. */
  preamble: Block[];
  viewpoints: { station: number; frames: ViewpointFrame<Block>[] }[];
}

export interface LoadedFrames extends PhotoViewpoints {
  blocks: Block[];
  /** Blob keys of the frames sent, by frame number. */
  paths: string[];
  frames: FrameInfo[];
  /** Full-resolution JPEG bytes by frame number, for zoom-in crops. */
  frameBytes: Uint8Array[];
}

export interface PassContext {
  provider: LlmProvider;
  blobs: BlobStore;
  usage: UsageTracker;
  logger: PipelineLogger;
  /** Effort per step, replacing the defaults below (the eval harness's effort sweep, plan §9.7.3). */
  effort?: Partial<Record<string, Effort>> | undefined;
}

/** Per-call options: a JSON schema for structured output and the effort level (Claude only). */
export interface CallOptions {
  schema?: Record<string, unknown>;
  effort?: Effort;
  /** Pipeline step, for logs and per-scan usage (e.g. "reconstruction"). */
  step: string;
}

/** Detection and geometry passes are accuracy-sensitive. */
const ANALYSIS_EFFORT: Effort = "high";

/** Parallel detection calls at a time within one run; the LlmGate caps all runs together. */
const DETECTION_CONCURRENCY = 4;

export function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function parseJson<T>(content: string): T {
  const cleaned = content
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // A model without structured outputs may wrap the object in prose. Fall
    // back to the outermost {...} or [...] span so a stray preamble doesn't
    // fail the run.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new LlmError("invalid_json", "AI analysis did not return parseable JSON");
  }
}

const SCHEMA = `{"name":string,"summary":string,"width_m":number,"length_m":number,"height_m":number,
"scale_reference":string,
"dimension_confidence":{"width":number,"length":number,"height":number,"overall":number,"basis":string},
"wall_evidence":[{"wall":"north"|"east"|"south"|"west","run_class":"long"|"short","landmarks_in_order":[string],"supporting_headings_deg":[number]}],
"objects":[{"label":string,"category":string,"confidence":number,"x_m":number,"y_m":number,"width_m":number,"depth_m":number,"height_m":number,"material":string,"against_wall":"north"|"east"|"south"|"west"|"none","yaw_deg":number,"wall_offset_m":number,"supporting_headings_deg":[number],"floor_elevation_m":number,"relative_to":string,"spatial_relation":"in_front_of"|"above"|"below"|"beside"|"none"}],
"surfaces":[{"name":string,"kind":string,"material":string,"area_m2":number,"absorption":number,"reflectivity":number,"color_hex":string,"notes":string}],
"portals":[{"kind":string,"wall":string,"offset_m":number,"width_m":number,"height_m":number,"sill_m":number,"confidence":number,"notes":string}]}`;

const OBJECT_INVENTORY_SCHEMA = `{"objects":[{"label":string,"category":string,"confidence":number,"x_m":number,"y_m":number,"width_m":number,"depth_m":number,"height_m":number,"material":string,"against_wall":"north"|"east"|"south"|"west"|"none","yaw_deg":number,"wall_offset_m":number,"supporting_headings_deg":[number],"floor_elevation_m":number,"relative_to":string,"spatial_relation":"in_front_of"|"above"|"below"|"beside"|"none","frame_boxes":[{"frame":number,"x0":number,"y0":number,"x1":number,"y1":number}]}]}`;

/** The passes of one analysis run, bound to its provider, blob store and usage tracker. */
export function createPasses(ctx: PassContext) {
  const { provider, blobs, logger } = ctx;
  const PRIMARY_MODEL = provider.primaryModel;
  const FALLBACK_MODEL = provider.fallbackModel;
  const budgets = provider.budgets;

  /**
   * Output-format instructions, for providers without structured outputs
   * only: with a schema enforced by the API the text would be noise.
   */
  const jsonFormat = (schemaText: string) =>
    provider.needsJsonInstructions
      ? `

Return STRICT JSON only, no prose, matching exactly:
${schemaText}`
      : "";

  const SYSTEM_PASS1 = `${prompt("pass1-reconstruction")}

${DEVICE_SCOPE_PROMPT}${jsonFormat(SCHEMA)}`;

  const SYSTEM_PASS2 = `${prompt("pass2-critique")}

${DEVICE_SCOPE_PROMPT}${jsonFormat(`${SCHEMA.slice(0, -1)},"revision_notes":[string]}`)}`;

  const SYSTEM_OBJECT_INVENTORY = `${prompt("object-inventory")}

${DEVICE_SCOPE_PROMPT}${jsonFormat(OBJECT_INVENTORY_SCHEMA)}`;

  const SYSTEM_INVENTORY_MERGE = `${prompt("object-inventory-merge")}${jsonFormat(OBJECT_INVENTORY_SCHEMA)}`;

  const SYSTEM_LANDMARKS = `${prompt("landmarks")}${jsonFormat(
    `{"sightings":[{"frame":number,"feature":string,"image_x":number,"confidence":number}]}`,
  )}`;

  const SYSTEM_PEOPLE = `${prompt("people-screener")}${jsonFormat(`{"frames_with_people":[number]}`)}`;

  function callModel(model: string, messages: PipelineMessage[], opts: CallOptions) {
    return provider.complete({
      model,
      messages,
      schema: opts.schema,
      effort: ctx.effort?.[opts.step] ?? opts.effort,
      step: opts.step,
      record: (call) => ctx.usage.record(call),
    });
  }

  /**
   * Call the model and parse its JSON reply, asking once more if the reply
   * doesn't parse (with a schema on Claude this should not happen; the local
   * model can still ramble).
   */
  async function requestJson<T>(
    model: string,
    messages: PipelineMessage[],
    opts: CallOptions,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const content = await callModel(model, messages, opts);
      try {
        return parseJson<T>(content);
      } catch (err) {
        lastError = err;
        logger.warn({ attempt, model, step: opts.step }, "model reply was not parseable JSON");
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LlmError("invalid_json", "AI analysis did not return JSON");
  }

  async function downloadFrame(path: string): Promise<Uint8Array | null> {
    let buf: Uint8Array;
    try {
      buf = await blobs.get(path);
    } catch (err) {
      logger.warn({ path, err: errString(err) }, "could not download a frame");
      return null;
    }
    if (!validateImageBytes(buf).ok) return null;
    // The media job already stripped EXIF (incl. GPS) after upload; strip
    // again in case a frame predates it, before the bytes leave for the model.
    return stripJpegExif(buf);
  }

  /**
   * Picks the analysis frames and loads them as model blocks. With `paths`,
   * loads exactly those frames in that order (a resumed run must number its
   * frames as the first attempt did).
   */
  async function loadPhotoBlocks(
    photos: AnalysisPhoto[],
    options: { paths?: string[] } = {},
  ): Promise<LoadedFrames> {
    const blocks: Block[] = [];
    const paths: string[] = [];
    // The capture protocol produces about 32 frames: 16 from the center and 4
    // from each corner. That whole set fits in one generation, so nothing is
    // sampled away and no wall is lost. The cap only guards runaway captures.
    // Local CPU-only inference cannot hold or process that many image tokens
    // in reasonable time, so it gets a much smaller budget instead.
    const MAX_FRAMES = budgets.maxFrames;

    // Even angular coverage beats even temporal coverage. Taking every Nth photo
    // over-samples whichever direction the user lingered on and can miss a wall
    // completely — which is how arches and second windows were being dropped.
    /** Sharpest frame per compass sector, up to `budget` frames. */
    const bySector = (pool: AnalysisPhoto[], budget: number) => {
      const withHeading = pool.filter((p) => p.heading_deg != null);
      if (withHeading.length === 0) {
        const step = Math.max(1, Math.ceil(pool.length / budget));
        return pool.filter((_, i) => i % step === 0).slice(0, budget);
      }
      const sectorSize = 360 / budget;
      const picked = new Map<number, AnalysisPhoto>();
      for (const p of withHeading) {
        const h = (((p.heading_deg as number) % 360) + 360) % 360;
        const sector = Math.floor(h / sectorSize);
        const held = picked.get(sector);
        // Within a sector keep the sharpest frame (the capture-time focus
        // measure, or for older frames the steadiest by the inertial track).
        if (!held || isBetterFrame(p, held)) picked.set(sector, p);
      }
      return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    };

    // A multi-viewpoint capture must keep frames from every standing position:
    // sampling the whole set by compass sector alone would collapse the
    // viewpoints into one and throw away exactly the parallax that makes the
    // geometry solvable. Budget evenly per viewpoint instead.
    const stationIds = [
      ...new Set(photos.map((p) => p.station).filter((s) => s != null)),
    ] as number[];
    let sampled: AnalysisPhoto[];
    if (options.paths) {
      const byPath = new Map(photos.map((p) => [p.path, p]));
      sampled = options.paths
        .map((path) => byPath.get(path))
        .filter((p): p is AnalysisPhoto => !!p);
    } else if (stationIds.length > 1) {
      stationIds.sort((a, b) => a - b);
      // The center turns a full circle and carries 16 directions; a corner
      // sweeps 120 degrees and carries 4 deliberate views. Budget accordingly so a
      // flat per-station split cannot throw away half of the center's coverage.
      // Corners keep the best frame of each of their ~40°-apart directions plus
      // the downward view; sampling them by compass sector would merge
      // neighbouring directions and drop half of each corner.
      const perStation = stationIds.map((id) => {
        const own = photos.filter((p) => p.station === id);
        if (id === 0) return bySector(own, budgets.centerFrames);
        return selectCornerFrames(own, budgets.cornerFrames, budgets.cornerLowView);
      });
      sampled = perStation.flat();
      if (sampled.length > MAX_FRAMES) {
        // Never truncate from the end because that erases the last corner first.
        // Keep at least one frame from every viewpoint, then fill the remaining
        // budget round-robin so all corner evidence survives a longer capture.
        const fair: AnalysisPhoto[] = [];
        for (let frameIndex = 0; fair.length < MAX_FRAMES; frameIndex++) {
          let added = false;
          for (const stationFrames of perStation) {
            const frame = stationFrames[frameIndex];
            if (!frame) continue;
            fair.push(frame);
            added = true;
            if (fair.length >= MAX_FRAMES) break;
          }
          if (!added) break;
        }
        sampled = fair;
      }
    } else {
      sampled = bySector(photos, MAX_FRAMES);
      if (sampled.length < MAX_FRAMES) {
        const chosen = new Set(sampled.map((p) => p.path));
        const rest = photos.filter((p) => !chosen.has(p.path));
        const step = Math.max(1, Math.ceil(rest.length / (MAX_FRAMES - sampled.length)));
        sampled = sampled.concat(rest.filter((_, i) => i % step === 0)).slice(0, MAX_FRAMES);
      }
    }

    // Sweep-arc briefing. The capture protocol is fixed: at every viewpoint the
    // user starts the pan facing along the LEFT wall and ends it facing along the
    // RIGHT wall. That makes the first and last heading of each corner sweep the
    // bearings of the two walls meeting behind the user, which is a hard
    // geometric constraint the model would otherwise have to guess.
    if (stationIds.length > 0) {
      const lines: string[] = [];
      for (const id of [...stationIds].sort((a, b) => a - b)) {
        const seq = photos
          .filter((p) => p.station === id && p.heading_deg != null)
          .sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
        const head = seq[0];
        const tail = seq[seq.length - 1];
        if (!head || !tail) continue;
        const first = Math.round((((head.heading_deg as number) % 360) + 360) % 360);
        const last = Math.round((((tail.heading_deg as number) % 360) + 360) % 360);
        lines.push(
          id === 0
            ? `Viewpoint 1 (room center): full turn, first frame ${first}°, last frame ${last}°.`
            : `Viewpoint ${id + 1} (near a room corner): this deliberate 120° pan STARTED at ${first}°, looking slightly behind along the wall to the user's left, and ENDED at ${last}°, looking along the wall to the user's right. The two middle frames overlap across the room interior. Treat the first and last views as direct evidence for the two adjacent walls, but do not force their compass headings to be exactly 90° apart because the phone is intentionally standing away from the geometric corner.`,
        );
      }
      if (lines.length) {
        blocks.push({
          type: "text",
          text: `CAPTURE PROTOCOL AND SWEEP ARCS. Viewpoint 1 is the room center (full 360° turn). Every later viewpoint is near a distinct room corner, panned 120° from slightly behind the left wall through two overlapping interior views to the right wall. The room is rectangular, so the four corner sweeps together cover all four walls with overlap.\n${lines.join("\n")}`,
        });
      }
    }

    // Frame geometry travels alongside the image blocks so a landmark spotted at
    // an image column can be turned back into a world bearing later.
    const frames: FrameInfo[] = [];
    // The same frames grouped by viewpoint, for per-viewpoint object detection,
    // and each frame's full-resolution bytes (by frame number) for zoom-in crops.
    const preamble = [...blocks];
    const frameBytes: Uint8Array[] = [];
    const viewpoints = new Map<number, ViewpointFrame<Block>[]>();

    for (const p of sampled) {
      const safe = await downloadFrame(p.path);
      if (!safe) continue;
      const fov = typeof p.fov_deg === "number" && p.fov_deg > 20 ? p.fov_deg : null;
      const caption = {
        type: "text",
        text: `Frame ${paths.length}${p.station == null ? "" : ` [viewpoint ${p.station + 1}]`}${
          p.view === "low"
            ? " — TILTED DOWN toward the floor to show low furniture and anything under tables"
            : ""
        } — heading ${p.heading_deg == null ? "unknown" : Math.round(p.heading_deg) + "°"}${
          fov
            ? `, horizontal field of view ${Math.round(fov)}°${p.ultra_wide ? " (ultra-wide 0.5x lens: straight walls bow slightly near the left and right edges, and objects at the edges look smaller and further away than they are)" : ""}. The left edge of this image looks toward ${p.heading_deg == null ? "heading unknown" : Math.round((((p.heading_deg - fov / 2) % 360) + 360) % 360) + "°"} and the right edge toward ${p.heading_deg == null ? "heading unknown" : Math.round((((p.heading_deg + fov / 2) % 360) + 360) % 360) + "°"}`
            : ""
        }${
          p.pose && isTrustedPose(p.pose)
            ? `, shot from station x=${p.pose.x.toFixed(2)} m east, y=${p.pose.y.toFixed(2)} m north of frame 0 (inertial, ±${Number(p.pose.drift_m ?? 0).toFixed(2)} m)`
            : ""
        } (captured ${p.captured_at}):`,
      };
      const image = {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${bytesToBase64(safe)}` },
      };
      blocks.push(caption, image);
      frameBytes[paths.length] = safe;
      const station = typeof p.station === "number" ? p.station : 0;
      viewpoints.set(station, [
        ...(viewpoints.get(station) ?? []),
        {
          heading: typeof p.heading_deg === "number" ? p.heading_deg : null,
          blocks: [caption, image],
        },
      ]);
      frames.push({
        frame: paths.length,
        station: typeof p.station === "number" ? p.station : 0,
        heading_deg: typeof p.heading_deg === "number" ? p.heading_deg : null,
        fov_deg: fov,
      });
      paths.push(p.path);
    }
    return {
      blocks,
      paths,
      frames,
      frameBytes,
      preamble,
      viewpoints: [...viewpoints.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([station, stationFrames]) => ({ station, frames: stationFrames })),
    };
  }

  /**
   * Privacy pass — asks the model which frames contain identifiable people.
   * With `strict`, a failed call throws instead of reporting "no people".
   */
  async function detectPeopleFrames(blocks: Block[], strict = false): Promise<number[]> {
    try {
      const parsed = await requestJson<{ frames_with_people?: unknown }>(
        PRIMARY_MODEL,
        [
          { role: "system", content: SYSTEM_PEOPLE },
          { role: "user", content: blocks },
        ],
        // A yes/no screen per frame; recall still matters, so not "low".
        { schema: PEOPLE_SCREENER_SCHEMA, effort: "medium", step: "people-screen" },
      );
      const list = Array.isArray(parsed.frames_with_people) ? parsed.frames_with_people : [];
      return list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0);
    } catch (err) {
      if (strict) throw err;
      return [];
    }
  }

  /**
   * Screens EVERY captured frame (not just the sampled ones sent to the vision
   * pass) for people, in small batches so each request stays fast. Returns the
   * storage paths that must be purged.
   */
  async function screenAllFramesForPeople(
    photos: Pick<AnalysisPhoto, "path">[],
    options: { strict?: boolean } = {},
  ): Promise<string[]> {
    const BATCH = 8;
    const doomed: string[] = [];
    for (let start = 0; start < photos.length; start += BATCH) {
      const slice = photos.slice(start, start + BATCH);
      const blocks: Block[] = [];
      const paths: string[] = [];
      for (const p of slice) {
        const safe = await downloadFrame(p.path);
        if (!safe) continue;
        blocks.push({ type: "text", text: `Frame ${paths.length}:` });
        blocks.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${bytesToBase64(safe)}` },
        });
        paths.push(p.path);
      }
      if (!blocks.length) continue;
      const flagged = await detectPeopleFrames(blocks, options.strict);
      for (const i of flagged) if (paths[i]) doomed.push(paths[i]);
    }
    return [...new Set(doomed)];
  }

  async function callWithFallback(
    messages: PipelineMessage[],
  ): Promise<{ result: AnalysisResult; model: string }> {
    const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
    for (const model of models) {
      try {
        const result = await requestJson<AnalysisResult>(model, messages, {
          schema: RECONSTRUCTION_SCHEMA,
          effort: ANALYSIS_EFFORT,
          step: "reconstruction",
        });
        return { result, model };
      } catch (err) {
        // Auth / rate-limit problems will not improve with another model.
        if (err instanceof LlmError && !err.tryOtherModel) throw err;
        if (model === models[models.length - 1]) throw err;
        logger.warn(
          { model, err: errString(err) },
          "reconstruction failed; trying the fallback model",
        );
      }
    }
    throw new LlmError("provider_unavailable", "AI analysis failed");
  }

  /** Pass 1 — reconstruct. */
  function runVisionAnalysis(
    blocks: Block[],
    context: string,
    inventory?: ObjectInventoryResult,
  ): Promise<{ result: AnalysisResult; model: string }> {
    // Frame boxes only served the zoom-in crops; they'd just cost tokens here.
    const inventoryForPrompt = inventory?.objects?.map((o) => {
      const { frame_boxes: _boxes, ...rest } = o as typeof o & { frame_boxes?: unknown };
      return rest;
    });
    const inventoryText = inventoryForPrompt?.length
      ? `\n\nINDEPENDENT VISUAL INVENTORY (observed before geometric reasoning):\n${JSON.stringify({ objects: inventoryForPrompt })}\nEvery listed detection came from the supplied images. Materialize each one in the reconstruction unless you can positively identify it as a duplicate of another listed detection. Uncertain wall assignment lowers confidence; it never justifies deleting a visible item.`
      : "";
    return callWithFallback([
      { role: "system", content: SYSTEM_PASS1 },
      { role: "user", content: [{ type: "text", text: context + inventoryText }, ...blocks] },
    ]);
  }

  async function detectObjects(
    content: Block[],
    context: string,
    step = "inventory",
  ): Promise<ObjectInventoryResult["objects"]> {
    const parsed = await requestJson<ObjectInventoryResult>(
      PRIMARY_MODEL,
      [
        { role: "system", content: SYSTEM_OBJECT_INVENTORY },
        { role: "user", content: [{ type: "text", text: context }, ...content] },
      ],
      { schema: OBJECT_INVENTORY_JSON_SCHEMA, effort: ANALYSIS_EFFORT, step },
    );
    return Array.isArray(parsed.objects) ? parsed.objects : [];
  }

  /**
   * Independent high-recall object pass, kept separate from shell reasoning.
   *
   * With several viewpoints, frames are detected in small per-viewpoint batches
   * (fewer images per call means fewer missed objects), then a text-only call
   * consolidates the batches so an object seen from several corners is listed
   * once. The local model gets a single call: several image-heavy requests
   * would multiply its CPU time.
   */
  async function runObjectInventoryPass(
    blocks: Block[],
    context: string,
    split?: PhotoViewpoints,
  ): Promise<ObjectInventoryResult> {
    const batches = split && budgets.batchDetection ? batchViewpoints(split.viewpoints) : [];
    if (!split || batches.length < 2) {
      return { objects: await detectObjects(blocks, context) };
    }

    const results = await mapWithConcurrency(batches, DETECTION_CONCURRENCY, async (batch) => {
      try {
        const objects = await detectObjects(
          [
            ...split.preamble,
            // Everything up to here (system prompt, context, capture protocol)
            // is the same for every batch: cache it once, read it per batch.
            CACHE_BREAKPOINT,
            {
              type: "text",
              text: `PARTIAL VIEW. The frames below are only those taken from ${batch.scope}. Report every in-scope item visible in these frames, even one that is probably also visible from another viewpoint; a later step merges the viewpoints.`,
            },
            ...batch.blocks,
          ],
          context,
          "inventory-batch",
        );
        return { station: batch.station, scope: batch.scope, objects, ok: true };
      } catch (err) {
        logger.warn({ scope: batch.scope, err: errString(err) }, "object detection batch failed");
        return { station: batch.station, scope: batch.scope, objects: [], ok: false };
      }
    });
    if (!results.some((r) => r.ok)) {
      return { objects: await detectObjects(blocks, context) };
    }

    const protocol = split.preamble
      .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
      .filter(Boolean);
    try {
      const merged = await requestJson<ObjectInventoryResult>(
        PRIMARY_MODEL,
        [
          { role: "system", content: SYSTEM_INVENTORY_MERGE },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  context,
                  ...protocol,
                  "DETECTIONS BY BATCH:",
                  JSON.stringify(results.map((r) => ({ batch: r.scope, objects: r.objects }))),
                ].join("\n\n"),
              },
            ],
          },
        ],
        { schema: OBJECT_INVENTORY_JSON_SCHEMA, effort: ANALYSIS_EFFORT, step: "inventory-merge" },
      );
      if (Array.isArray(merged.objects)) return { objects: merged.objects };
    } catch (err) {
      logger.warn(
        { err: errString(err) },
        "inventory consolidation failed; merging deterministically",
      );
    }
    return { objects: mergeBatchInventories(results) };
  }

  /**
   * Landmark pass — where fixed architecture sits in each frame, so the graph
   * solver can triangulate real positions instead of trusting a single guess.
   */
  async function runLandmarkPass(blocks: Block[], context: string): Promise<RawSighting[]> {
    try {
      const parsed = await requestJson<{ sightings?: RawSighting[] }>(
        PRIMARY_MODEL,
        [
          { role: "system", content: SYSTEM_LANDMARKS },
          { role: "user", content: [{ type: "text", text: context }, ...blocks] },
        ],
        { schema: LANDMARK_SCHEMA, effort: ANALYSIS_EFFORT, step: "landmarks" },
      );
      if (!Array.isArray(parsed?.sightings)) return [];
      return parsed.sightings.filter(
        (s) =>
          s &&
          Number.isFinite(Number(s.frame)) &&
          typeof s.feature === "string" &&
          Number.isFinite(Number(s.image_x)),
      );
    } catch {
      // Triangulation is an upgrade, never a gate on the reconstruction.
      return [];
    }
  }

  /** Pass 2 — critique and correct. Falls back to the draft if the audit fails. */
  async function runCritiquePass(
    blocks: Block[],
    context: string,
    draft: AnalysisResult,
    issues: string[],
  ): Promise<{ result: AnalysisResult; model: string; critiqued: boolean }> {
    const review = [
      context,
      "",
      "DRAFT RECONSTRUCTION:",
      JSON.stringify(draft),
      "",
      issues.length
        ? `AUTOMATICALLY DETECTED PROBLEMS:\n- ${issues.join("\n- ")}`
        : "No automatic problems were detected, but audit the draft anyway.",
    ].join("\n");

    try {
      // Single model, no cross-model retry: the audit is optional and must never
      // be the reason the whole analysis runs out of time.
      const result = await requestJson<AnalysisResult>(
        PRIMARY_MODEL,
        [
          { role: "system", content: SYSTEM_PASS2 },
          { role: "user", content: [{ type: "text", text: review }, ...blocks] },
        ],
        { schema: CRITIQUE_SCHEMA, effort: ANALYSIS_EFFORT, step: "review" },
      );
      if (!result || !Number.isFinite(Number(result.width_m))) {
        return { result: draft, model: PRIMARY_MODEL, critiqued: false };
      }
      return { result, model: PRIMARY_MODEL, critiqued: true };
    } catch {
      return { result: draft, model: PRIMARY_MODEL, critiqued: false };
    }
  }

  return {
    primaryModel: PRIMARY_MODEL,
    requestJson,
    loadPhotoBlocks,
    detectPeopleFrames,
    screenAllFramesForPeople,
    runVisionAnalysis,
    runObjectInventoryPass,
    runLandmarkPass,
    runCritiquePass,
  };
}

export type Passes = ReturnType<typeof createPasses>;
