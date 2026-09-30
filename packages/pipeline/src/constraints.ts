// Everything between the review pass and persistence, ported unchanged in
// behaviour from `analyzeScan` (`src/lib/scan.functions.ts`): evidence
// retention, plan alignment, the metric scale constraints (triangulation,
// walked perimeter, acoustic ranging), the plausibility clamp, known-product
// dimensions, wall snapping, relationship repair and the scope filter.
// Deterministic apart from the catalog lookup, so it is recomputed on resume
// rather than checkpointed.
import { objectsToRestore } from "@spatial/domain/object-reconcile";
import { keepDetectedObject } from "@spatial/domain/object-scope";
import { catalogCategoryFor, type ProductDimension } from "@spatial/domain/product-catalog";
import { MAX_SHELL_RATIO, shellAgrees } from "@spatial/domain/shell-check";
import type { RoomGraph } from "./graph";
import {
  alignPlanToLedger,
  alignShellToWallEvidence,
  findGeometryIssues,
  num,
} from "./plan-geometry";
import type { ScanInputs } from "./scan-inputs";
import type { AnalysisResult } from "./types";

type AnalysisObject = AnalysisResult["objects"][number];

export interface ConstraintInput {
  /** The review's output (or the aligned draft when the review was skipped). */
  result: AnalysisResult;
  /** Snapshots of the aligned first pass, taken before the review. */
  validatedWallEvidence: NonNullable<AnalysisResult["wall_evidence"]>;
  firstPassObjects: AnalysisResult["objects"];
  firstPassPortals: AnalysisResult["portals"];
  inventoryObjects: AnalysisResult["objects"];
  inputs: ScanInputs;
  graph: RoomGraph;
  matchProduct: (category: string, label: string) => Promise<ProductDimension | null>;
}

export interface ConstrainedResult {
  result: AnalysisResult;
  width: number;
  length: number;
  height: number;
  /** Catalog product each resized object was matched to. */
  catalogRefs: Map<AnalysisObject, string>;
  residualIssues: string[];
}

export async function applyConstraints(input: ConstraintInput): Promise<ConstrainedResult> {
  const { result, validatedWallEvidence, firstPassObjects, firstPassPortals, inventoryObjects } =
    input;
  const { measuredShell, walkedShell, rangedShell, spanEast, spanNorth, stationSeeds } =
    input.inputs;
  const { solved, solvedShell, stationDataAligned, observedStationIds } = input.graph;
  const hasMeasuredShell = !!measuredShell;

  // The optional review must not discard an already validated wall ledger or
  // silently erase a confidently detected physical object. Keep the review's
  // corrections, then restore only instances the review really dropped:
  // objects are matched by type and counted, not by label, because passes
  // rename freely ("TV" vs "flat-screen smart TV (Google TV)") and a label
  // match would restore every renamed object as a duplicate. Door and window
  // parts are never restored; they belong to the portals.
  if ((result.wall_evidence ?? []).length < 4 && validatedWallEvidence.length === 4) {
    result.wall_evidence = validatedWallEvidence;
  }
  for (const o of objectsToRestore(result.objects ?? [], firstPassObjects, 0.6)) {
    result.objects = [...(result.objects ?? []), o];
    result.revision_notes = [
      ...(result.revision_notes ?? []),
      `Retained first-pass ${String(o.label ?? "object")} on the ${String(o.against_wall ?? "unassigned")} wall because the review dropped a confident detection of that kind.`,
    ];
  }
  // Same for the dedicated inventory: it saw each frame on its own, so a type
  // it counted more of than the reconstruction kept is evidence retention.
  for (const o of objectsToRestore(result.objects ?? [], inventoryObjects, 0.45)) {
    result.objects = [...(result.objects ?? []), o];
    result.revision_notes = [
      ...(result.revision_notes ?? []),
      `Restored visually observed ${String(o.label ?? "object")} from the independent frame inventory.`,
    ];
  }
  // The review is allowed to correct portal geometry, but not silently erase
  // a distinct opening that the first reconstruction found. Preserve counts
  // by kind and physical wall, which keeps a second window on another wall.
  const portalKey = (p: (typeof firstPassPortals)[number]) =>
    `${String(p.kind ?? "opening").toLowerCase()}|${String(p.wall ?? "unknown").toLowerCase()}`;
  const reviewedPortalCounts = new Map<string, number>();
  for (const p of result.portals ?? []) {
    const key = portalKey(p);
    reviewedPortalCounts.set(key, (reviewedPortalCounts.get(key) ?? 0) + 1);
  }
  const seenFirstPassPortals = new Map<string, number>();
  for (const p of firstPassPortals) {
    const key = portalKey(p);
    const ordinal = (seenFirstPassPortals.get(key) ?? 0) + 1;
    seenFirstPassPortals.set(key, ordinal);
    if (ordinal <= (reviewedPortalCounts.get(key) ?? 0)) continue;
    if ((num(p.confidence, 0) ?? 0) < 0.55) continue;
    result.portals = [...(result.portals ?? []), p];
    result.revision_notes = [
      ...(result.revision_notes ?? []),
      `Retained a first-pass ${String(p.kind ?? "opening")} on the ${String(p.wall ?? "unassigned")} wall because the review omitted a confident portal.`,
    ];
  }
  alignShellToWallEvidence(result);
  alignPlanToLedger(result);

  // ---- metric scale constraints ----
  // Rescaling one axis moves every object and portal on that axis with it, so
  // the layout keeps its proportions while the room takes the measured size.
  const rescaleAxis = (current: number, factor: number, axis: "x" | "y") => {
    if (factor > 0.999 && factor < 1.001) return current;
    for (const o of result.objects ?? []) {
      if (axis === "x") o.x_m = (num(o.x_m, 0) ?? 0) * factor;
      else o.y_m = (num(o.y_m, 0) ?? 0) * factor;
      if (typeof o.wall_offset_m === "number") {
        const wall = String(o.against_wall ?? "").toLowerCase();
        const onAxis =
          axis === "x" ? wall === "north" || wall === "south" : wall === "east" || wall === "west";
        if (onAxis) o.wall_offset_m *= factor;
      }
    }
    for (const p of result.portals ?? []) {
      const wall = String(p.wall ?? "").toLowerCase();
      const onAxis =
        axis === "x" ? wall === "north" || wall === "south" : wall === "east" || wall === "west";
      if (!onAxis) continue;
      if (typeof p.offset_m === "number") p.offset_m *= factor;
      if (typeof p.width_m === "number") p.width_m *= factor;
    }
    return current * factor;
  };

  // ---- solved graph constraint (primary metric source) ----
  // The graph fuses the walked legs with every triangulated wall feature, so
  // when it converges well it outranks the raw legs it was built from.
  let usedWalkedShell = false;
  const rejectedNote = (source: string, w: number, l: number, beforeW: number, beforeL: number) =>
    `Ignored the ${source} room size of ${w.toFixed(2)} m x ${l.toFixed(2)} m: it differs from the reconstruction's estimate of ${beforeW.toFixed(2)} m x ${beforeL.toFixed(2)} m by more than ${Math.round((MAX_SHELL_RATIO - 1) * 100)} percent on an axis, which points to bad compass or motion data.`;
  if (!hasMeasuredShell && solvedShell && solvedShell.quality >= 0.45) {
    const beforeW = num(result.width_m, 0) ?? 0;
    const beforeL = num(result.length_m, 0) ?? 0;
    const agrees = shellAgrees(solvedShell, { width_m: beforeW, length_m: beforeL });
    if (beforeW > 0 && beforeL > 0 && !agrees) {
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        rejectedNote("triangulated", solvedShell.width_m, solvedShell.length_m, beforeW, beforeL),
      ];
    }
    if (beforeW > 0 && beforeL > 0 && agrees) {
      result.width_m =
        Math.round(rescaleAxis(beforeW, solvedShell.width_m / beforeW, "x") * 100) / 100;
      result.length_m =
        Math.round(rescaleAxis(beforeL, solvedShell.length_m / beforeL, "y") * 100) / 100;
      usedWalkedShell = true;
      result.scale_reference = `Multi-view triangulation + walk, roughly ±8% (${solved?.basis ?? "triangulated landmarks"})`;
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        `Shell set by triangulation to ${result.width_m} m x ${result.length_m} m; bearing residual ${solved?.bearing_residual_deg}°.`,
      ];
    }
  }

  // ---- walked perimeter constraint ----
  // Four legs walked corner to corner, each integrated between two
  // zero-velocity anchors, are the only true metric measurement in a
  // browser capture. Vision can only guess at scale, so the walk wins.
  const walkedAgrees =
    !walkedShell ||
    shellAgrees(walkedShell, {
      width_m: num(result.width_m, 0) ?? 0,
      length_m: num(result.length_m, 0) ?? 0,
    });
  if (!hasMeasuredShell && !usedWalkedShell && walkedShell && !walkedAgrees) {
    result.revision_notes = [
      ...(result.revision_notes ?? []),
      rejectedNote(
        "walked",
        walkedShell.width_m,
        walkedShell.length_m,
        num(result.width_m, 0) ?? 0,
        num(result.length_m, 0) ?? 0,
      ),
    ];
  }
  if (
    !hasMeasuredShell &&
    !usedWalkedShell &&
    walkedShell &&
    walkedAgrees &&
    walkedShell.quality >= 0.3
  ) {
    const beforeW = num(result.width_m, 0) ?? 0;
    const beforeL = num(result.length_m, 0) ?? 0;
    const applyWalk = (measured: number, current: number, axis: "x" | "y") => {
      if (!(measured > 1.2 && measured < 25) || current <= 0) return current;
      return rescaleAxis(current, measured / current, axis);
    };
    const w = applyWalk(walkedShell.width_m, beforeW, "x");
    const l = applyWalk(walkedShell.length_m, beforeL, "y");
    result.width_m = Math.round(w * 100) / 100;
    result.length_m = Math.round(l * 100) / 100;
    usedWalkedShell = true;
    result.scale_reference = `Walked perimeter, roughly ±15% (${walkedShell.legs.length} legs, closure ${walkedShell.closure_error_m} m)`;
    if (Math.abs(result.width_m - beforeW) > 0.05 || Math.abs(result.length_m - beforeL) > 0.05) {
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        `Shell rescaled from the visual estimate ${beforeW.toFixed(2)} m x ${beforeL.toFixed(2)} m to the walked ${result.width_m} m x ${result.length_m} m (${walkedShell.basis}).`,
      ];
    }
  }

  // ---- acoustic ranging constraint ----
  // Time-of-flight beats a guessed door leaf, but never beats the walk. When
  // both walls on an axis were ranged we take that run as the shell and
  // rescale everything on that axis so objects and portals keep their
  // relative position. A single-sided range only sets a floor, because it
  // cannot see past the phone.
  if (!hasMeasuredShell && !usedWalkedShell && rangedShell) {
    const scaleAxis = (measured: number | null, current: number, axis: "x" | "y") => {
      if (!measured || measured < 1.6 || measured > 13 || current <= 0) return current;
      const factor = measured / current;
      // The chirp is a sanity check on the imagery, not a licence to turn a
      // living room into a skating rink. If the two disagree by more than
      // about a third, the echo picker most likely locked onto reverb, so we
      // keep the visual estimate.
      if (factor > 1.4 || factor < 0.7) {
        result.revision_notes = [
          ...(result.revision_notes ?? []),
          `Ignored the acoustic ${axis === "x" ? "east-west" : "north-south"} run of ${measured.toFixed(2)} m: it disagrees with the visual estimate of ${current.toFixed(2)} m by more than 40 percent, so it is treated as an unreliable echo.`,
        ];
        return current;
      }
      return rescaleAxis(current, factor, axis);
    };

    const beforeW = num(result.width_m, 0) ?? 0;
    const beforeL = num(result.length_m, 0) ?? 0;
    const newW = scaleAxis(rangedShell.width_m, beforeW, "x");
    const newL = scaleAxis(rangedShell.length_m, beforeL, "y");
    result.width_m = Math.round(newW * 100) / 100;
    result.length_m = Math.round(newL * 100) / 100;
    if (rangedShell.min_width_m && (result.width_m ?? 0) < rangedShell.min_width_m) {
      result.width_m = rangedShell.min_width_m;
    }
    if (rangedShell.min_length_m && (result.length_m ?? 0) < rangedShell.min_length_m) {
      result.length_m = rangedShell.min_length_m;
    }
    if (Math.abs(result.width_m - beforeW) > 0.05 || Math.abs(result.length_m - beforeL) > 0.05) {
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        `Shell rescaled from the visual estimate ${beforeW.toFixed(2)} m x ${beforeL.toFixed(2)} m to the acoustically measured ${result.width_m} m x ${result.length_m} m (${rangedShell.basis}).`,
      ];
    }
    result.scale_reference = `Acoustic ranging, roughly ±20% (${rangedShell.walls.length} walls)`;
  }

  // Measured depth wins outright: the model can misjudge scale, a bounding
  // box from a real scanner cannot.
  // Without a surveyed shell the walked path still gives a hard lower bound:
  // you cannot walk 4 m across a 3 m room.
  const trackFloor = (v: number, span: number) => (span > 0.5 ? Math.max(v, span + 0.6) : v);
  let width = measuredShell
    ? measuredShell.width
    : usedWalkedShell
      ? (num(result.width_m, 4) ?? 4)
      : trackFloor(num(result.width_m, 4) ?? 4, spanEast);
  let length = measuredShell
    ? measuredShell.length
    : usedWalkedShell
      ? (num(result.length_m, 4) ?? 4)
      : trackFloor(num(result.length_m, 4) ?? 4, spanNorth);
  const height = measuredShell ? measuredShell.height : (num(result.height_m, 2.6) ?? 2.6);

  // ---- plausibility clamp on an unsurveyed shell ----
  // Halls, offices and meeting rooms reach 10-15 m, so the limits allow them.
  // Without imported depth data, hold each run inside habitable limits and
  // cap the floor area, rescaling contents so nothing drifts off the plan.
  // A walked shell is a measurement, so it is exempt.
  if (!hasMeasuredShell && !usedWalkedShell) {
    const beforeW = width;
    const beforeL = length;
    width = Math.min(Math.max(width, 1.8), 16);
    length = Math.min(Math.max(length, 1.8), 16);
    const maxArea = 200;
    if (width * length > maxArea) {
      const shrink = Math.sqrt(maxArea / (width * length));
      width = Math.round(width * shrink * 100) / 100;
      length = Math.round(length * shrink * 100) / 100;
    }
    const fx = beforeW > 0 ? width / beforeW : 1;
    const fy = beforeL > 0 ? length / beforeL : 1;
    if (Math.abs(fx - 1) > 0.005 || Math.abs(fy - 1) > 0.005) {
      for (const o of result.objects ?? []) {
        o.x_m = (num(o.x_m, 0) ?? 0) * fx;
        o.y_m = (num(o.y_m, 0) ?? 0) * fy;
      }
      for (const p of result.portals ?? []) {
        const wall = String(p.wall ?? "").toLowerCase();
        const f = wall === "north" || wall === "south" ? fx : fy;
        if (typeof p.offset_m === "number") p.offset_m *= f;
        if (typeof p.width_m === "number") p.width_m *= f;
      }
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        `Shell clamped from ${beforeW.toFixed(2)} m x ${beforeL.toFixed(2)} m to ${width.toFixed(2)} m x ${length.toFixed(2)} m: the estimate exceeded the plausible size of a photographed room with this ceiling height.`,
      ];
    }
  }

  result.width_m = Math.round(width * 100) / 100;
  result.length_m = Math.round(length * 100) / 100;
  result.height_m = height;

  // ---- known-product dimension anchor ----
  // When a detection matches a catalog reference (e.g. a "55-inch TV"),
  // replace the VLM's guessed footprint with the surveyed dimensions.
  // Object-level only: this corrects the item, never the room shell. It is
  // an enhancement, so any failure is swallowed and persistence continues.
  // Runs before wall snapping so the snap uses the corrected depth and the
  // object ends up flush with its wall.
  const catalogRefs = new Map<AnalysisObject, string>();
  try {
    const memo = new Map<string, ProductDimension | null>();
    for (const o of result.objects ?? []) {
      const label = String(o.label ?? "");
      // The model's category is free text; map it onto the catalog's set.
      const category = catalogCategoryFor(String(o.category ?? ""), label);
      if (!category || !label) continue;
      const memoKey = `${category}|${label.toLowerCase()}`;
      let known = memo.get(memoKey);
      if (known === undefined) {
        known = await input.matchProduct(category, label);
        memo.set(memoKey, known);
      }
      if (!known) continue;
      if (known.width_m != null) o.width_m = known.width_m;
      if (known.height_m != null) o.height_m = known.height_m;
      if (known.depth_m != null) o.depth_m = known.depth_m;
      catalogRefs.set(o, known.label);
      result.revision_notes = [
        ...(result.revision_notes ?? []),
        `Corrected ${label} dimensions to catalog reference "${known.label}".`,
      ];
    }
  } catch {
    // Catalog lookup unavailable — keep the VLM's estimated dimensions.
  }

  // ---- wall snapping: back-of-object flush with its wall ----
  // The model names the wall; we do the arithmetic so a piano or sofa never
  // ends up floating a few centimeters proud of the plaster.
  const WALL_ITEMS =
    /sofa|couch|settee|piano|bed\b|bookcase|bookshelf|shelf|sideboard|wardrobe|cabinet|dresser|desk|tv|television|credenza|console|mantel|mantle|beam|clock|mirror/i;
  for (const o of result.objects ?? []) {
    const depth = num(o.depth_m, 0.5) ?? 0.5;
    let wall = String(o.against_wall ?? "").toLowerCase();
    const cardinal = wall.match(/north|east|south|west/)?.[0];
    if (cardinal) {
      wall = cardinal;
      o.against_wall = cardinal;
    }
    if (wall === "none") continue;
    if (!["north", "east", "south", "west"].includes(wall)) {
      // No wall declared: infer one only for furniture that belongs on a wall
      // and already sits close to it.
      if (!WALL_ITEMS.test(String(o.label ?? ""))) continue;
      const x = num(o.x_m, 0) ?? 0;
      const y = num(o.y_m, 0) ?? 0;
      const gaps: [string, number][] = [
        ["north", length / 2 - y],
        ["south", length / 2 + y],
        ["east", width / 2 - x],
        ["west", width / 2 + x],
      ];
      gaps.sort((a, b) => a[1] - b[1]);
      const nearest = gaps[0];
      if (!nearest || nearest[1] > depth / 2 + 1.0) continue;
      wall = nearest[0];
      o.against_wall = wall;
    }
    if (typeof o.yaw_deg !== "number") {
      o.yaw_deg = wall === "north" ? 180 : wall === "south" ? 0 : wall === "east" ? 270 : 90;
    }
    const yaw = ((num(o.yaw_deg, 0) ?? 0) * Math.PI) / 180;
    const objectWidth = num(o.width_m, 0.5) ?? 0.5;
    const xExtent = Math.abs(Math.cos(yaw)) * objectWidth + Math.abs(Math.sin(yaw)) * depth;
    const yExtent = Math.abs(Math.sin(yaw)) * objectWidth + Math.abs(Math.cos(yaw)) * depth;
    // The model reports a stable wall-relative center offset derived from
    // headings and inertial station deltas. Recompute the free axis from it
    // instead of trusting an x/y guess that may drift between frames.
    const wallOffset = num(o.wall_offset_m, null);
    if (wallOffset != null) {
      if (wall === "north" || wall === "south") o.x_m = -width / 2 + wallOffset;
      else o.y_m = -length / 2 + wallOffset;
    }
    if (wall === "north") o.y_m = length / 2 - yExtent / 2;
    else if (wall === "south") o.y_m = -length / 2 + yExtent / 2;
    else if (wall === "east") o.x_m = width / 2 - xExtent / 2;
    else if (wall === "west") o.x_m = -width / 2 + xExtent / 2;
    // Keep the other axis inside the room too.
    if (wall === "north" || wall === "south") {
      const limit = Math.max(0, width / 2 - xExtent / 2);
      o.x_m = Math.min(limit, Math.max(-limit, num(o.x_m, 0) ?? 0));
    } else {
      const limit = Math.max(0, length / 2 - yExtent / 2);
      o.y_m = Math.min(limit, Math.max(-limit, num(o.y_m, 0) ?? 0));
    }
  }

  // ---- object-to-object relationship repair ----
  // Vision establishes the relationship; deterministic geometry preserves it
  // when x/y estimates drift between overlapping frames.
  const byLabel = new Map(
    (result.objects ?? []).map(
      (o) =>
        [
          String(o.label ?? "")
            .toLowerCase()
            .trim(),
          o,
        ] as const,
    ),
  );
  for (const o of result.objects ?? []) {
    const parentName = String(o.relative_to ?? "")
      .toLowerCase()
      .trim();
    const parent = byLabel.get(parentName);
    if (!parent) continue;
    const relation = String(o.spatial_relation ?? "none");
    if (relation === "in_front_of") {
      const parentWall = String(parent.against_wall ?? "").toLowerCase();
      const parentDepth = num(parent.depth_m, 0.5) ?? 0.5;
      const childDepth = num(o.depth_m, 0.4) ?? 0.4;
      const inset = Math.min(0.12, childDepth * 0.3);
      o.yaw_deg = num(parent.yaw_deg, 0) ?? 0;
      if (parentWall === "north") {
        o.x_m = parent.x_m;
        o.y_m = length / 2 - parentDepth - childDepth / 2 + inset;
      } else if (parentWall === "south") {
        o.x_m = parent.x_m;
        o.y_m = -length / 2 + parentDepth + childDepth / 2 - inset;
      } else if (parentWall === "east") {
        o.x_m = width / 2 - parentDepth - childDepth / 2 + inset;
        o.y_m = parent.y_m;
      } else if (parentWall === "west") {
        o.x_m = -width / 2 + parentDepth + childDepth / 2 - inset;
        o.y_m = parent.y_m;
      }
      o.against_wall = "none";
    } else if (relation === "above" || relation === "below") {
      o.x_m = num(parent.x_m, 0) ?? 0;
      o.y_m = num(parent.y_m, 0) ?? 0;
      if (typeof parent.against_wall === "string") o.against_wall = parent.against_wall;
      if (typeof parent.yaw_deg === "number") o.yaw_deg = parent.yaw_deg;
      if (relation === "above" && num(o.floor_elevation_m, null) == null) {
        o.floor_elevation_m =
          (num(parent.floor_elevation_m, 0) ?? 0) + (num(parent.height_m, 0.5) ?? 0.5) + 0.08;
      }
    }
  }

  const residualIssues = findGeometryIssues(
    result,
    input.inputs.acousticVolume,
    input.inputs.reflectionDistance,
  );

  if (!stationDataAligned && stationSeeds.length > 0) {
    residualIssues.push(
      `Station metadata is inconsistent: ${stationSeeds.length} position seeds do not match ${observedStationIds.size} photographed viewpoints. Do not triangulate across mismatched stations; rely on the wall ledger and visual evidence.`,
    );
  }

  // Scope guard: drop small loose clutter, but always keep major items and
  // AV / IT devices whatever their size (see object-scope.ts).
  result.objects = (result.objects ?? []).filter(keepDetectedObject);

  return { result, width, length, height, catalogRefs, residualIssues };
}
