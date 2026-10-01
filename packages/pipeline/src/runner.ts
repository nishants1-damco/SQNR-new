// One analysis run as checkpointed stages (plan §9.4), replacing the single
// long `analyzeScan` request. The order and the logic between stages are the
// original's; what changed is that each expensive stage saves its output, so
// a job retried after a crash, a deploy or a transient model failure resumes
// where it stopped instead of paying for the same passes twice.
//
//   load       frames chosen for the run (by blob key, in frame order)
//   detect     object inventory + landmark sightings + people screening
//   catalog    product-catalog retrieval
//   verify     zoom-in verification + visual catalog match
//   pass1      reconstruction
//   pass2      geometric audit + critique
//   persist    one transaction: rows, layers, poses, privacy purge, status
//
// The graph solve and the constraints (metric scale, clamps, anchors, wall
// snapping, relationship repair) are pure and cheap, so they are recomputed
// on resume instead of being checkpointed.
import {
  formatCatalogContext,
  catalogCategoryFor,
  type CatalogMatch,
} from "@spatial/domain/product-catalog";
import type { InventoryObject } from "@spatial/domain/object-verification";
import type { RawSighting } from "@spatial/domain/landmarks";
import { buildLayers, roomFootprint } from "@spatial/domain/scan-spatial";
import { appMetrics, inSpan } from "@spatial/observability";
import type { BlobStore } from "@spatial/storage";
import type { CatalogSource } from "./catalog";
import { applyConstraints } from "./constraints";
import { solveRoomGraph } from "./graph";
import { PipelineError } from "./llm/errors";
import type { Effort, LlmProvider } from "./llm/types";
import { type LlmCall, UsageTracker, type UsageSummary } from "./llm/usage";
import { errString, type PipelineLogger } from "./logger";
import { createPasses, type LoadedFrames } from "./passes";
import { alignPlanToLedger, alignShellToWallEvidence, findGeometryIssues } from "./plan-geometry";
import { PROMPT_VERSION } from "./prompts";
import { framePoseRows, navigationGraph, objectRows, portalRows, surfaceRows } from "./rows";
import { buildContextText, scanInputs } from "./scan-inputs";
import type { AnalysisStore, Checkpoint, RunRef } from "./store";
import type { AnalysisResult, ObjectInventoryResult } from "./types";
import { verifyInventoryObjects } from "./verification";

export const STAGES = {
  load: { pct: 5, message: "Loading frames" },
  detect: { pct: 15, message: "Finding objects and landmarks" },
  catalog: { pct: 40, message: "Matching known products" },
  verify: { pct: 45, message: "Checking objects up close" },
  pass1: { pct: 55, message: "Reconstructing the room" },
  pass2: { pct: 75, message: "Reviewing the reconstruction" },
  persist: { pct: 92, message: "Saving the results" },
  done: { pct: 100, message: "Done" },
} as const;
export type StageName = keyof typeof STAGES;

export interface ProgressEvent {
  scanId: string;
  analysisId: string;
  stage: StageName;
  pct: number;
  message: string;
}

export interface AnalysisDeps {
  store: AnalysisStore;
  blobs: BlobStore;
  provider: LlmProvider;
  catalog: CatalogSource;
  logger: PipelineLogger;
  /** Called at the start of every stage (the worker publishes it for SSE, plan §9.6). */
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
  /**
   * Wall-clock budget, from the start of detection, after which the review
   * pass is skipped unless the draft has structural problems. The original
   * app's 100 s came from its request time limit; kept as the default so
   * results match, and worth revisiting with the eval harness.
   */
  reviewBudgetMs?: number;
  /** Effort per pipeline step, overriding the defaults (plan §9.7.3). */
  effort?: Partial<Record<string, Effort>>;
}

export type AnalysisOutcome =
  | {
      status: "succeeded";
      objects: number;
      surfaces: number;
      portals: number;
      resumedStages: StageName[];
      usage: UsageSummary;
    }
  | { status: "skipped"; reason: string };

/** Thrown when a run fails; carries the usage so far, for `scan_analyses`. */
export class AnalysisRunError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly usage: UsageSummary,
  ) {
    super(errString(cause));
    this.name = "AnalysisRunError";
  }
}

export const DEFAULT_REVIEW_BUDGET_MS = 100_000;

interface LoadData {
  paths: string[];
  /** When detection started on the first attempt: the review budget runs from here. */
  startedAt: number;
}

interface DetectData {
  inventory: ObjectInventoryResult;
  sightings: RawSighting[];
  privacyPaths: string[];
}

interface CatalogData {
  catalogText: string;
  catalogRows: CatalogMatch[];
}

interface VerifyData {
  objects: ObjectInventoryResult["objects"];
  notes: string[];
  catalogText: string;
}

interface Pass1Data {
  result: AnalysisResult;
  model: string;
}

interface Pass2Data {
  result: AnalysisResult;
  model: string;
  critiqued: boolean;
}

export async function runAnalysis(deps: AnalysisDeps, run: RunRef): Promise<AnalysisOutcome> {
  const { store, provider, logger } = deps;
  const log = logger;
  const state = await store.startRun(run);
  if (state.kind === "gone") {
    log.info({ ...run, reason: state.reason }, "analysis skipped");
    return { status: "skipped", reason: state.reason };
  }

  const usage = new UsageTracker();
  const saved = await store.checkpoints(run.analysisId);
  // Calls from earlier attempts, including ones that failed mid-stage.
  usage.restore([...saved.values()].flatMap((c) => c.calls ?? []));
  const resumedStages: StageName[] = [];
  let recorded = usage.calls.length;
  const newCalls = (): LlmCall[] => {
    const calls = usage.calls.slice(recorded);
    recorded = usage.calls.length;
    return calls;
  };

  const progress = async (stage: StageName) => {
    const { pct, message } = STAGES[stage];
    await store.setStage(run, stage, pct).catch(() => undefined);
    await Promise.resolve(
      deps.onProgress?.({ scanId: run.scanId, analysisId: run.analysisId, stage, pct, message }),
    ).catch(() => undefined);
  };

  /** Runs a stage once per run: a saved checkpoint is returned instead of re-running it. */
  const stage = async <T>(name: StageName, produce: () => Promise<T>): Promise<T> => {
    const done = saved.get(name) as Checkpoint<T> | undefined;
    if (done) {
      resumedStages.push(name);
      return done.data;
    }
    await progress(name);
    const started = Date.now();
    const data = await inSpan(`analysis.${name}`, produce, {
      attributes: { "spatial.scan.id": run.scanId, "spatial.analysis.id": run.analysisId },
    });
    appMetrics().stageDuration.record((Date.now() - started) / 1000, {
      stage: name,
      provider: provider.kind,
    });
    await store.saveCheckpoint(run.analysisId, name, { data, calls: newCalls() });
    return data;
  };

  const passes = createPasses({
    provider,
    blobs: deps.blobs,
    usage,
    logger,
    effort: deps.effort,
  });

  try {
    const scan = await store.loadScan(run);
    const photos = await store.loadPhotos(run.scanId);
    const inputs = scanInputs(scan, photos);
    const { posed } = inputs;

    // ---- load ----
    let frames: LoadedFrames | null = null;
    let load = saved.get("load") as Checkpoint<LoadData> | undefined;
    if (load) {
      frames = await passes.loadPhotoBlocks(posed, { paths: load.data.paths });
      const same =
        frames.paths.length === load.data.paths.length &&
        frames.paths.every((p, i) => p === load?.data.paths[i]);
      if (!same) {
        // A frame vanished between attempts (deleted, or its blob is gone):
        // frame numbers in later checkpoints no longer line up. Start over.
        log.warn({ ...run }, "analysis frames changed since the last attempt; starting over");
        await store.clearCheckpoints(run.analysisId);
        saved.clear();
        load = undefined;
      } else {
        resumedStages.push("load");
      }
    }
    if (!load) {
      await progress("load");
      frames = await passes.loadPhotoBlocks(posed);
      load = { data: { paths: frames.paths, startedAt: Date.now() }, calls: [] };
      if (frames.frames.length > 0) await store.saveCheckpoint(run.analysisId, "load", load);
    }
    if (!frames) throw new Error("frames not loaded");
    const startedAt = load.data.startedAt;
    const { blocks, frameBytes, preamble, viewpoints } = frames;
    log.info(
      {
        ...run,
        frames: frames.frames.length,
        viewpoints: viewpoints.length,
        provider: provider.kind,
        model: provider.primaryModel,
        resumed: resumedStages,
      },
      "analysis started",
    );
    if (frames.frames.length === 0) {
      throw new PipelineError("no_frames", "No photos available to analyze");
    }

    const contextText = buildContextText(scan, inputs, frames.frames.length);

    // ---- visual inventory + landmark spotting + people screening ----
    // A dedicated recall pass prevents small/dark/nested objects from being
    // sacrificed while the main model spends its attention budget on shell
    // topology, dimensions, portals and surfaces. The landmark pass runs
    // alongside it and feeds the geometric solve.
    const detected = await stage<DetectData>("detect", async () => {
      const [inventory, sightings, privacyPaths] = await Promise.all([
        passes
          .runObjectInventoryPass(blocks, contextText, { preamble, viewpoints })
          .catch((): ObjectInventoryResult => ({ objects: [] })),
        passes.runLandmarkPass(blocks, contextText).catch(() => [] as RawSighting[]),
        passes.screenAllFramesForPeople(posed).catch(() => [] as string[]),
      ]);
      log.info(
        {
          ...run,
          objects: inventory.objects?.length ?? 0,
          landmark_sightings: sightings.length,
          frames_with_people: privacyPaths.length,
        },
        "detection done",
      );
      return { inventory, sightings, privacyPaths };
    });
    const inventory: ObjectInventoryResult = structuredClone(detected.inventory);

    // ---- graph solve: stations and landmarks optimized together ----
    const graph = solveRoomGraph(inputs, frames.frames, detected.sightings);

    // ---- product-catalog RAG ----
    // Embed what the inventory pass actually saw and retrieve the closest
    // real devices from the catalog vector index, then hand the model those
    // names + surveyed dimensions so it reasons from known hardware instead
    // of guessing. Best-effort: no embedding backend or no seeded vectors
    // just yields an empty string and the prompt is unchanged.
    const catalogStage = await stage<CatalogData>("catalog", async () => {
      try {
        const queries = [
          scan.name ? String(scan.name) : "",
          ...(inventory.objects ?? []).flatMap((o) => [
            String(o.label ?? ""),
            String(o.category ?? ""),
          ]),
        ];
        const matches = await deps.catalog.retrieveCatalogMatches(queries);
        return { catalogText: formatCatalogContext(matches), catalogRows: matches };
      } catch {
        // Retrieval is an enhancement; never let it break analysis.
        return { catalogText: "", catalogRows: [] };
      }
    });
    let catalogText = catalogStage.catalogText;
    const catalogRows = catalogStage.catalogRows;
    // Show the model the matched devices' reference photos so it can
    // recognize them in the room frames. Cloud only: on-device models run
    // CPU-bound, so extra image tokens there blow the latency budget.
    if (provider.budgets.extraImageCalls && catalogRows.length) {
      const refBlocks = await deps.catalog
        .buildCatalogImageBlocks(catalogRows, { maxImages: 2 })
        .catch(() => []);
      if (refBlocks.length) blocks.push(...refBlocks);
    }

    // ---- zoom-in verification + visual catalog match ----
    // Crop each detection out of its clearest full-resolution frame and have
    // the model confirm what it is, and whether it's one of the catalog's
    // products: by reference photo, or by name and specs when the product
    // has none. Cloud only: extra image calls would multiply a CPU-bound
    // local model's time.
    const verificationNotes: string[] = [];
    if (provider.budgets.extraImageCalls && (inventory.objects ?? []).length) {
      const verified = await stage<VerifyData | null>("verify", async () => {
        try {
          const categories = [
            ...new Set(
              inventory.objects
                .map((o) => catalogCategoryFor(String(o.category ?? ""), String(o.label ?? "")))
                .filter((c): c is string => !!c),
            ),
          ];
          const branded = await deps.catalog.loadBrandedProducts(categories);
          const result = await verifyInventoryObjects({
            passes,
            catalogSource: deps.catalog,
            logger,
            objects: inventory.objects as InventoryObject[],
            frameBytes,
            catalog: [...catalogRows, ...branded],
          });
          log.info(
            { ...run, objects: result.objects.length, changes: result.notes.length },
            "zoom-in verification done",
          );
          // Products identified only through the category lookup still need
          // their dimensions in the reconstruction prompt.
          const matchedLabels = new Set(
            result.objects.map((o) => o.catalog_match).filter((l): l is string => !!l),
          );
          const extra = branded.filter(
            (b) => matchedLabels.has(b.label) && !catalogRows.some((r) => r.id === b.id),
          );
          return {
            objects: result.objects as ObjectInventoryResult["objects"],
            notes: result.notes,
            catalogText: extra.length
              ? formatCatalogContext([...catalogRows, ...extra])
              : catalogText,
          };
        } catch (err) {
          log.warn({ ...run, err: errString(err) }, "zoom-in verification skipped");
          return null;
        }
      });
      if (verified) {
        inventory.objects = structuredClone(verified.objects);
        verificationNotes.push(...verified.notes);
        catalogText = verified.catalogText;
      }
    }

    const reconstructionContext = [contextText, graph.solvedText, catalogText]
      .filter(Boolean)
      .join("\n\n");

    const pass1Data = await stage<Pass1Data>("pass1", async () => {
      const pass1 = await passes.runVisionAnalysis(blocks, reconstructionContext, inventory);
      log.info(
        {
          ...run,
          model: pass1.model,
          objects: pass1.result.objects?.length ?? 0,
          portals: pass1.result.portals?.length ?? 0,
        },
        "reconstruction done",
      );
      return pass1;
    });
    const pass1 = { result: structuredClone(pass1Data.result), model: pass1Data.model };

    // ---- geometric audit + pass 2: critique and correct ----
    // Repair a transposed shell before the audit: if the wall ledger says the
    // long run belongs to a different axis than the numbers do, rotate the plan
    // so the long wall keeps its own landmarks, portals and furniture.
    alignShellToWallEvidence(pass1.result);
    // A rotation alone cannot repair a plan whose walls were mirrored, so also
    // test every way the plan can sit on the compass and keep the one whose
    // furniture and portals match the wall ledger.
    alignPlanToLedger(pass1.result);
    const validatedWallEvidence = structuredClone(pass1.result.wall_evidence ?? []);
    const firstPassObjects = structuredClone(pass1.result.objects ?? []);
    const firstPassPortals = structuredClone(pass1.result.portals ?? []);
    const inventoryObjects = structuredClone(inventory.objects ?? []);
    const issues = findGeometryIssues(
      pass1.result,
      inputs.acousticVolume,
      inputs.reflectionDistance,
    );
    // A structural contradiction, such as a sofa standing in a doorway, is
    // never acceptable output. Those get the second look even when the time
    // budget has run out; cosmetic issues respect the budget.
    const structural = issues.some((i) =>
      /placed across the|occupy the same floor area|wrong wall|transposed/i.test(i),
    );
    const budget = deps.reviewBudgetMs ?? DEFAULT_REVIEW_BUDGET_MS;
    const pass2Data = await stage<Pass2Data>("pass2", async () => {
      const pass2 =
        structural || Date.now() - startedAt < budget
          ? await passes.runCritiquePass(
              blocks,
              catalogText ? `${contextText}\n\n${catalogText}` : contextText,
              pass1.result,
              issues,
            )
          : { result: pass1.result, model: pass1.model, critiqued: false };
      log.info(
        { ...run, objects: pass2.result.objects?.length ?? 0 },
        pass2.critiqued ? "review done" : "review skipped",
      );
      return pass2;
    });
    const pass2 = { ...pass2Data, result: structuredClone(pass2Data.result) };

    // ---- constraints: evidence retention, metric scale, snapping, repair ----
    const constrained = await applyConstraints({
      result: pass2.result,
      validatedWallEvidence,
      firstPassObjects,
      firstPassPortals,
      inventoryObjects,
      inputs,
      graph,
      matchProduct: (category, label) => deps.catalog.matchProduct(category, label),
    });
    const { result, width, length, height, residualIssues } = constrained;
    const dims = { width, length, height };

    // ---- persist ----
    await progress("persist");
    const objects = objectRows(result, constrained.catalogRefs);
    const surfaces = surfaceRows(result, dims);
    const portals = portalRows(result, dims);
    const nav = navigationGraph(portals, dims);
    const modelLabel = `${pass1.model} → ${pass2.model}${pass2.critiqued ? " (audited)" : " (audit skipped)"}`;
    const layers = buildLayers({
      scanId: run.scanId,
      userId: run.userId,
      photos,
      acoustics: inputs.acoustics,
      depthSource: scan.depth_source ?? null,
      dims,
      objects,
      surfaces,
      portals,
      navNodes: nav.nodes.length,
      navEdges: nav.edges.length,
      summary: result.summary ?? null,
      roomName: result.name || scan.name,
      model: modelLabel,
    }).map(({ scan_id: _scan, user_id: _user, ...layer }) => layer);

    const summary = usage.summary();
    const written = await store.persist(run, {
      objects,
      surfaces,
      portals,
      navNodes: nav.nodes,
      navEdges: nav.edges,
      framePoses: framePoseRows(posed),
      layers,
      privacyPaths: detected.privacyPaths,
      analysisNotes: {
        inertial_track: {
          frames_with_pose: inputs.stations.length,
          span_east_m: Math.round(inputs.spanEast * 100) / 100,
          span_north_m: Math.round(inputs.spanNorth * 100) / 100,
        },
        pass1_model: pass1.model,
        verification_notes: verificationNotes,
        inventory_objects: inventoryObjects.map((o) => ({
          label: o.label,
          confidence: o.confidence,
          against_wall: o.against_wall,
          supporting_headings_deg: o.supporting_headings_deg ?? [],
        })),
        review_model: pass2.model,
        critiqued: pass2.critiqued,
        issues_found: issues,
        revision_notes: result.revision_notes ?? [],
        wall_evidence: result.wall_evidence ?? [],
        residual_issues: residualIssues,
        acoustic_volume_m3: inputs.acousticVolume,
        visual_volume_m3: Math.round(width * length * height * 100) / 100,
        stage: "done",
        progress_pct: 100,
        error: null,
      },
      scan: {
        name: result.name || scan.name,
        summary: result.summary ?? null,
        width,
        length,
        height,
        footprint: roomFootprint(width, length),
        dimensionConfidence: JSON.parse(
          JSON.stringify(result.dimension_confidence ?? {}),
        ) as Record<string, unknown>,
        scaleReference: inputs.measuredShell
          ? "Measured depth file, roughly ±2%"
          : (result.scale_reference ??
            (scan.depth_source
              ? "Imported depth, roughly ±5%"
              : "Single-view visual estimate, roughly ±25%")),
        provider: provider.kind,
        modelVersion: provider.primaryModel,
        promptVersion: PROMPT_VERSION,
      },
      frameCount: frames.frames.length,
      usage: summary,
      metrics: {
        objects: objects.length,
        surfaces: surfaces.length,
        portals: portals.length,
        residual_issues: residualIssues,
        resumed_stages: resumedStages,
      },
    });
    if (!written) {
      log.warn({ ...run }, "analysis finished after losing its scan; results discarded");
      return { status: "skipped", reason: "scan no longer owned by this run" };
    }
    await Promise.resolve(
      deps.onProgress?.({
        scanId: run.scanId,
        analysisId: run.analysisId,
        ...STAGES.done,
        stage: "done",
      }),
    ).catch(() => undefined);
    log.info(
      {
        ...run,
        ms: usage.elapsedMs(),
        objects: objects.length,
        surfaces: surfaces.length,
        portals: portals.length,
        llm_calls: summary.calls,
        estimated_cost_usd: summary.estimated_cost_usd,
      },
      "analysis complete",
    );
    return {
      status: "succeeded",
      objects: objects.length,
      surfaces: surfaces.length,
      portals: portals.length,
      resumedStages,
      usage: summary,
    };
  } catch (err) {
    // Keep the calls this attempt paid for, so a retry (or the failure
    // record) still counts them.
    const calls = newCalls();
    if (calls.length) {
      await store
        .saveCheckpoint(run.analysisId, `calls:${state.attempts}`, { data: null, calls })
        .catch(() => undefined);
    }
    throw new AnalysisRunError(err, usage.summary());
  }
}
