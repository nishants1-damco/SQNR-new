// Deterministic repairs and checks on a reconstruction, ported unchanged from
// `src/lib/scan-analysis.server.ts` (rotatePlan90 through num). No I/O.
import type { AnalysisResult } from "./types";

const CW: Record<string, string> = { north: "east", east: "south", south: "west", west: "north" };

/**
 * Rotate the whole plan 90 degrees clockwise about the room center.
 * (x east, y north) -> (y, -x). North becomes east, east becomes south, and so
 * on, so width and length swap while the physical topology is preserved.
 */
function rotatePlan90(r: AnalysisResult): AnalysisResult {
  const w = num(r.width_m, 0) ?? 0;
  const l = num(r.length_m, 0) ?? 0;
  const remap = (wall: unknown) => {
    const key = String(wall ?? "").toLowerCase();
    return CW[key] ?? key;
  };

  r.width_m = l;
  r.length_m = w;

  for (const o of r.objects ?? []) {
    const x = num(o.x_m, 0) ?? 0;
    const y = num(o.y_m, 0) ?? 0;
    o.x_m = y;
    o.y_m = -x;
    if (o.against_wall) o.against_wall = remap(o.against_wall);
    if (typeof o.yaw_deg === "number") o.yaw_deg = (((o.yaw_deg + 90) % 360) + 360) % 360;
    if (
      typeof o.wall_offset_m === "number" &&
      (String(o.against_wall ?? "").toLowerCase() === "east" ||
        String(o.against_wall ?? "").toLowerCase() === "west")
    ) {
      o.wall_offset_m = Math.max(0, w - o.wall_offset_m);
    }
  }

  for (const p of r.portals ?? []) {
    const from = String(p.wall ?? "").toLowerCase();
    const to = remap(from);
    // Offsets are measured from the west end on north/south walls and from the
    // south end on east/west walls. Rotating north->east and south->west flips
    // which end that is, so those two offsets are mirrored along the run.
    const run = from === "north" || from === "south" ? w : l;
    const off = num(p.offset_m, 0) ?? 0;
    const pw = num(p.width_m, 0) ?? 0;
    if (from === "north" || from === "south") {
      p.offset_m = Math.max(0, run - off - pw);
    }
    p.wall = to;
  }

  for (const e of r.wall_evidence ?? []) {
    e.wall = remap(e.wall);
  }

  for (const s of r.surfaces ?? []) {
    const name = String(s.name ?? "");
    const lower = name.toLowerCase();
    for (const key of Object.keys(CW)) {
      if (lower.includes(key)) {
        s.name = name.replace(new RegExp(key, "i"), CW[key] as string);
        break;
      }
    }
  }

  return r;
}

/**
 * The single most common failure is a transposed shell: the model reads the
 * room correctly wall by wall, then hangs that ledger on the wrong compass
 * axis, so the long wall's contents end up on a short wall. The ledger is
 * better evidence than the compass mapping, so when the two disagree we rotate
 * the plan rather than trusting the mapping.
 */
export function alignShellToWallEvidence(r: AnalysisResult): {
  rotated: boolean;
  reason: string | null;
} {
  const w = num(r.width_m, 0) ?? 0;
  const l = num(r.length_m, 0) ?? 0;
  if (w <= 0 || l <= 0 || Math.abs(w - l) < 0.25) return { rotated: false, reason: null };

  const byWall = new Map(
    (r.wall_evidence ?? []).map((e) => [String(e.wall).toLowerCase(), e] as const),
  );
  const classOf = (a: string, b: string) => {
    const first = byWall.get(a)?.run_class;
    const second = byWall.get(b)?.run_class;
    if (first && second && first === second) return first;
    return first ?? second ?? null;
  };
  const ewClass = classOf("north", "south"); // north/south walls run east-west (width_m)
  const nsClass = classOf("east", "west"); // east/west walls run north-south (length_m)

  // Fallback when the ledger is thin: the wall carrying the most distinct
  // landmarks is the long wall.
  const landmarkCount = (wall: string) => byWall.get(wall)?.landmarks_in_order?.length ?? 0;
  const ewLandmarks = landmarkCount("north") + landmarkCount("south");
  const nsLandmarks = landmarkCount("east") + landmarkCount("west");

  let wantsWidthLonger: boolean | null = null;
  if (ewClass && nsClass && ewClass !== nsClass) {
    wantsWidthLonger = ewClass === "long";
  } else if (ewClass && !nsClass) {
    wantsWidthLonger = ewClass === "long";
  } else if (nsClass && !ewClass) {
    wantsWidthLonger = nsClass === "short";
  } else if (Math.abs(ewLandmarks - nsLandmarks) >= 2) {
    wantsWidthLonger = ewLandmarks > nsLandmarks;
  }

  if (wantsWidthLonger == null) return { rotated: false, reason: null };
  const widthIsLonger = w > l;
  if (wantsWidthLonger === widthIsLonger) return { rotated: false, reason: null };

  rotatePlan90(r);
  const reason = `Wall ledger put the long run on the ${wantsWidthLonger ? "north/south" : "east/west"} walls while the shell was ${w} m x ${l} m; the plan was rotated 90 degrees so the long wall and everything on it stay together.`;
  r.revision_notes = [...(r.revision_notes ?? []), reason];
  return { rotated: true, reason };
}

/**
 * Mirror the plan across the east-west axis (y -> -y). North and south trade
 * places, east and west keep their identity. A rotation alone can never do
 * this, which is why a plain quarter-turn search cannot repair a room whose
 * ledger was hung on the wall opposite the right one.
 */
function mirrorPlanNS(r: AnalysisResult): AnalysisResult {
  const l = num(r.length_m, 0) ?? 0;
  const flip = (wall: unknown) => {
    const key = String(wall ?? "").toLowerCase();
    if (key === "north") return "south";
    if (key === "south") return "north";
    return key;
  };

  for (const o of r.objects ?? []) {
    o.y_m = -(num(o.y_m, 0) ?? 0);
    if (o.against_wall) o.against_wall = flip(o.against_wall);
    if (typeof o.yaw_deg === "number") o.yaw_deg = (((180 - o.yaw_deg) % 360) + 360) % 360;
    // Offsets on east/west walls are measured from the south end, which the
    // mirror moves to the other end of the run.
    const wall = String(o.against_wall ?? "").toLowerCase();
    if (typeof o.wall_offset_m === "number" && (wall === "east" || wall === "west")) {
      o.wall_offset_m = Math.max(0, l - o.wall_offset_m);
    }
  }

  for (const p of r.portals ?? []) {
    const from = String(p.wall ?? "").toLowerCase();
    if (from === "east" || from === "west") {
      const off = num(p.offset_m, 0) ?? 0;
      const pw = num(p.width_m, 0) ?? 0;
      p.offset_m = Math.max(0, l - off - pw);
    }
    p.wall = flip(from);
  }

  for (const e of r.wall_evidence ?? []) e.wall = flip(e.wall);

  for (const s of r.surfaces ?? []) {
    const name = String(s.name ?? "");
    if (/north/i.test(name)) s.name = name.replace(/north/i, "south");
    else if (/south/i.test(name)) s.name = name.replace(/south/i, "north");
  }

  return r;
}

/**
 * How well the placed contents agree with the wall ledger: for every object
 * and portal, does the wall it was assigned to actually list it as one of its
 * landmarks? A correct plan scores high; a plan whose walls were shuffled
 * scores low even when each individual wall reads correctly.
 */
function ledgerAgreement(r: AnalysisResult): number {
  const byWall = new Map(
    (r.wall_evidence ?? []).map(
      (e) =>
        [
          String(e.wall ?? "").toLowerCase(),
          (e.landmarks_in_order ?? []).map((t) => String(t ?? "").toLowerCase()),
        ] as const,
    ),
  );
  if (!byWall.size) return 0;
  const words = (s: string) => s.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const hit = (wall: string, label: string) => {
    const marks = byWall.get(wall);
    if (!marks?.length) return 0;
    const tokens = words(label.toLowerCase());
    if (!tokens.length) return 0;
    return marks.some((m) => tokens.some((t) => m.includes(t))) ? 1 : 0;
  };
  let score = 0;
  for (const o of r.objects ?? []) {
    score += hit(String(o.against_wall ?? "").toLowerCase(), String(o.label ?? ""));
  }
  for (const p of r.portals ?? []) {
    // Portals are the strongest anchors, so agreement on them counts double.
    score += 2 * hit(String(p.wall ?? "").toLowerCase(), String(p.kind ?? ""));
  }
  return score;
}

/**
 * Search the eight ways a rectangular plan can be laid on the compass (four
 * rotations, each with or without a north/south mirror) and keep the one whose
 * contents best match the wall ledger. Only a clearly better arrangement wins,
 * so a confident plan is left untouched.
 */
export function alignPlanToLedger(r: AnalysisResult): string | null {
  const base = ledgerAgreement(r);
  if (base <= 0) return null;
  const clone = () => JSON.parse(JSON.stringify(r)) as AnalysisResult;

  let best: { score: number; plan: AnalysisResult; label: string } | null = null;
  for (let turns = 0; turns < 4; turns++) {
    for (const mirrored of [false, true]) {
      if (turns === 0 && !mirrored) continue;
      const candidate = clone();
      for (let i = 0; i < turns; i++) rotatePlan90(candidate);
      if (mirrored) mirrorPlanNS(candidate);
      const score = ledgerAgreement(candidate);
      if (!best || score > best.score) {
        best = {
          score,
          plan: candidate,
          label: `${turns * 90} degrees${mirrored ? " with a north/south mirror" : ""}`,
        };
      }
    }
  }

  // Require a clear win: a tie means the ledger cannot tell the two apart.
  if (!best || best.score <= base + 1) return null;

  for (const key of Object.keys(r)) delete (r as unknown as Record<string, unknown>)[key];
  Object.assign(r, best.plan);
  const reason = `Wall contents matched the ledger far better when the plan was turned ${best.label}, so the compass mapping was corrected before placement.`;
  r.revision_notes = [...(r.revision_notes ?? []), reason];
  return reason;
}

/**
 * Geometric sanity checks run between the two passes. Returns human-readable
 * problems for the reviewer, so corrections come from the model rather than
 * from blind clamping.
 */
export function findGeometryIssues(
  r: AnalysisResult,
  acousticVolumeM3: number | null,
  reflectionDistanceM: number | null = null,
): string[] {
  const issues: string[] = [];
  const w = num(r.width_m, 0) ?? 0;
  const l = num(r.length_m, 0) ?? 0;
  const h = num(r.height_m, 0) ?? 0;

  const evidence = r.wall_evidence ?? [];
  if (evidence.length < 4)
    issues.push(
      `Wall evidence covers only ${evidence.length} of 4 walls; rebuild the physical wall adjacency loop from all frames.`,
    );
  const evidenceByWall = new Map(
    evidence.map((entry) => [String(entry.wall).toLowerCase(), entry]),
  );
  for (const [a, b] of [
    ["north", "south"],
    ["east", "west"],
  ] as const) {
    const first = evidenceByWall.get(a);
    const second = evidenceByWall.get(b);
    if (first && second && first.run_class !== second.run_class) {
      issues.push(
        `${a} and ${b} are opposite walls but have different run classes; repair the wall-to-compass mapping.`,
      );
    }
  }
  const northClass = evidenceByWall.get("north")?.run_class;
  const eastClass = evidenceByWall.get("east")?.run_class;
  if (northClass && eastClass && northClass === eastClass) {
    issues.push(
      "Adjacent north and east walls have the same run class; one axis has been mapped incorrectly.",
    );
  }
  if (w > 0 && l > 0 && Math.abs(w - l) >= 0.25) {
    const longAxis = w > l ? "north/south (they run width_m)" : "east/west (they run length_m)";
    for (const [wall, entry] of evidenceByWall) {
      const run = wall === "north" || wall === "south" ? w : l;
      const isLongRun = run >= Math.max(w, l) - 0.001;
      if (entry.run_class === "long" && !isLongRun) {
        issues.push(
          `The ${wall} wall is classed as the long wall but its run is only ${run} m in a ${w} m x ${l} m shell. Either the shell is transposed or the ledger is on the wrong axis; the long walls in this shell are the ${longAxis}. Move the whole wall — its landmarks, portals and furniture — not just its label.`,
        );
      }
      if (entry.run_class === "short" && isLongRun && Math.abs(w - l) >= 0.25) {
        issues.push(
          `The ${wall} wall is classed as short but it carries the ${run} m run, the longest in the shell. Re-check which physical wall the numbers belong to.`,
        );
      }
    }
  }

  if (w <= 0.5 || l <= 0.5) issues.push("Room width/length is missing or implausibly small.");
  if (h < 2.2 || h > 4) issues.push(`Ceiling height ${h} m is outside the usual 2.2-4.0 m range.`);
  if (w > 40 || l > 40)
    issues.push("Room footprint exceeds 40 m on a side — check the scale anchor.");

  for (const o of r.objects ?? []) {
    const x = num(o.x_m, 0) ?? 0;
    const y = num(o.y_m, 0) ?? 0;
    if (Math.abs(x) > w / 2 + 0.2 || Math.abs(y) > l / 2 + 0.2) {
      issues.push(`Object "${o.label}" at (${x}, ${y}) lies outside the room bounds.`);
    }
    if ((num(o.height_m, 0) ?? 0) > h) {
      issues.push(`Object "${o.label}" is taller than the ceiling.`);
    }
    const wall = String(o.against_wall ?? "").toLowerCase();
    if (["north", "east", "south", "west"].includes(wall)) {
      const run = wall === "north" || wall === "south" ? w : l;
      const offset = num(o.wall_offset_m, null);
      if (offset == null) {
        issues.push(
          `Object "${o.label}" on the ${wall} wall has no wall_offset_m; derive its center position from compass headings and inertial station deltas.`,
        );
      } else if (offset < 0 || offset > run) {
        issues.push(
          `Object "${o.label}" has wall_offset_m ${offset} outside its ${run} m ${wall} wall.`,
        );
      }
      if (!Array.isArray(o.supporting_headings_deg) || o.supporting_headings_deg.length === 0) {
        issues.push(
          `Object "${o.label}" has no supporting frame headings, so its wall assignment cannot be checked against the gyroscope/compass sweep.`,
        );
      }
    }
  }

  const floorObjects = (r.objects ?? []).filter(
    (object) => (num(object.floor_elevation_m, 0) ?? 0) < 0.15 && (num(object.width_m, 0) ?? 0) > 0,
  );
  for (let i = 0; i < floorObjects.length; i += 1) {
    const a = floorObjects[i];
    if (!a) continue;
    for (let j = i + 1; j < floorObjects.length; j += 1) {
      const b = floorObjects[j];
      if (!b) continue;
      const related =
        String(a.relative_to ?? "").toLowerCase() === String(b.label ?? "").toLowerCase() ||
        String(b.relative_to ?? "").toLowerCase() === String(a.label ?? "").toLowerCase();
      if (related) continue;
      const ax = num(a.x_m, 0) ?? 0;
      const ay = num(a.y_m, 0) ?? 0;
      const bx = num(b.x_m, 0) ?? 0;
      const by = num(b.y_m, 0) ?? 0;
      const aw = num(a.width_m, 0.5) ?? 0.5;
      const ad = num(a.depth_m, 0.5) ?? 0.5;
      const bw = num(b.width_m, 0.5) ?? 0.5;
      const bd = num(b.depth_m, 0.5) ?? 0.5;
      const overlapX = Math.min(ax + aw / 2, bx + bw / 2) - Math.max(ax - aw / 2, bx - bw / 2);
      const overlapY = Math.min(ay + ad / 2, by + bd / 2) - Math.max(ay - ad / 2, by - bd / 2);
      if (overlapX > 0.12 && overlapY > 0.12) {
        issues.push(
          `Objects "${a.label}" and "${b.label}" occupy the same floor area. Re-check their separate station sightings and wall offsets; do not stack unrelated furniture.`,
        );
      }
    }
  }

  // A doorway or archway is a hole in the wall, so no floor-standing item can
  // share that stretch of it. When the two collide the placement is wrong, not
  // the opening: the frames show where the furniture actually stands, so send
  // the conflict back to be re-read rather than nudging anything sideways.
  for (const o of r.objects ?? []) {
    const wall = String(o.against_wall ?? "").toLowerCase();
    if (!["north", "east", "south", "west"].includes(wall)) continue;
    if ((num(o.floor_elevation_m, 0) ?? 0) > 0.4) continue;
    const run = wall === "north" || wall === "south" ? w : l;
    const yaw = ((num(o.yaw_deg, 0) ?? 0) * Math.PI) / 180;
    const ow = num(o.width_m, 0.5) ?? 0.5;
    const od = num(o.depth_m, 0.5) ?? 0.5;
    const span =
      wall === "north" || wall === "south"
        ? Math.abs(Math.cos(yaw)) * ow + Math.abs(Math.sin(yaw)) * od
        : Math.abs(Math.sin(yaw)) * ow + Math.abs(Math.cos(yaw)) * od;
    const center =
      num(o.wall_offset_m, null) ??
      (wall === "north" || wall === "south"
        ? (num(o.x_m, 0) ?? 0) + w / 2
        : (num(o.y_m, 0) ?? 0) + l / 2);
    for (const p of r.portals ?? []) {
      if (String(p.wall ?? "").toLowerCase() !== wall) continue;
      // A window with a real sill can have a sofa beneath it; a door, archway
      // or any floor-level opening cannot.
      if ((num(p.sill_m, 0) ?? 0) >= 0.35) continue;
      const pw = Math.max(num(p.width_m, 0.9) ?? 0.9, 0.2);
      const pStart = Math.min(Math.max(num(p.offset_m, 0) ?? 0, 0), Math.max(run - pw, 0));
      const overlap =
        Math.min(center + span / 2, pStart + pw) - Math.max(center - span / 2, pStart);
      if (overlap > 0.1) {
        issues.push(
          `"${o.label}" is placed across the ${p.kind} on the ${wall} wall (item spans ${(center - span / 2).toFixed(2)}-${(center + span / 2).toFixed(2)} m, opening spans ${pStart.toFixed(2)}-${(pStart + pw).toFixed(2)} m). Nothing can stand in an opening. Look again at the frames that show this opening: either the item belongs on a different wall or the opening does. Correct whichever one the photographs contradict; do not simply shift the item along the wall.`,
        );
      }
    }
  }

  const seen = new Map<string, number>();
  for (const o of r.objects ?? []) {
    const k = `${o.label}`.toLowerCase().trim();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 3)
      issues.push(`"${k}" appears ${n} times — check for duplicates across overlapping frames.`);
  }

  const wallsWithPortals = new Set<string>();
  const wallsWithWindows = new Set<string>();
  const spans = new Map<string, { a: number; b: number; kind: string }[]>();
  for (const p of r.portals ?? []) {
    const wall = String(p.wall ?? "").toLowerCase();
    if (!["north", "east", "south", "west"].includes(wall)) {
      issues.push(
        `Portal "${p.kind}" has invalid or missing wall "${wall}"; identify its physical wall from frame evidence instead of defaulting it.`,
      );
      continue;
    }
    const run = wall === "north" || wall === "south" ? w : l;
    const off = num(p.offset_m, 0) ?? 0;
    const pw = num(p.width_m, 0) ?? 0;
    const kind = String(p.kind ?? "door");
    wallsWithPortals.add(wall);
    if (/window|glaz/i.test(kind)) wallsWithWindows.add(wall);
    if (run > 0 && (off < -0.05 || off + pw > run + 0.1)) {
      issues.push(
        `Portal on the ${wall} wall (offset ${off} m, width ${pw} m) does not sit on a ${run} m wall — offset is measured from the west end on north/south walls and from the south end on east/west walls, must be >= 0, and offset + width must be <= ${run} m.`,
      );
    }
    const ph = num(p.height_m, 0) ?? 0;
    const sill = num(p.sill_m, 0) ?? 0;
    if (ph > h) issues.push(`Portal on the ${wall} wall is taller than the ceiling.`);
    if (sill < 0) issues.push(`Portal on the ${wall} wall has a negative sill height.`);
    if (h > 0 && sill + ph > h + 0.05) {
      issues.push(
        `Portal on the ${wall} wall (sill ${sill} m + height ${ph} m) reaches above the ${h} m ceiling.`,
      );
    }
    if (/door|archway|opening|open_side|pass/i.test(kind) && sill > 0.05) {
      issues.push(
        `A ${kind} on the ${wall} wall was given a ${sill} m sill; doors and open thresholds sit on the floor (sill 0).`,
      );
    }
    if (/window/i.test(kind) && sill === 0 && ph < h - 0.3) {
      issues.push(
        `The window on the ${wall} wall has no sill height; a normal window sill is 0.8-1.0 m unless the glazing runs to the floor.`,
      );
    }
    if (/^door$|doorway/i.test(kind) && (pw < 0.6 || pw > 1.3)) {
      issues.push(
        `The door on the ${wall} wall is ${pw} m wide; single doors are 0.76-0.91 m and double doors 1.5-1.8 m.`,
      );
    }
    const list = spans.get(wall) ?? [];
    list.push({ a: off, b: off + pw, kind });
    spans.set(wall, list);
  }
  for (const [wall, list] of spans) {
    const sorted = [...list].sort((x, y) => x.a - y.a);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.a < prev.b - 0.05) {
        issues.push(
          `Two portals overlap on the ${wall} wall (${prev.kind} ends at ${prev.b.toFixed(2)} m, ${cur.kind} starts at ${cur.a.toFixed(2)} m) — separate them or merge them into one opening.`,
        );
      }
    }
    const run = wall === "north" || wall === "south" ? w : l;
    const total = sorted.reduce((sum, s) => sum + (s.b - s.a), 0);
    if (run > 0 && total > run * 0.95 && !sorted.some((s) => /open_side/i.test(s.kind))) {
      issues.push(
        `Openings on the ${wall} wall add up to ${total.toFixed(2)} m of a ${run} m wall — if that side of the room is genuinely open, report a single "open_side" portal spanning the whole wall instead.`,
      );
    }
  }
  for (const wall of ["north", "east", "south", "west"]) {
    if (!wallsWithPortals.has(wall)) {
      issues.push(
        `No portal at all was reported on the ${wall} wall — re-check that wall for a door, window, archway, pass-through or an entirely open side before leaving it blank.`,
      );
    }
  }

  if (wallsWithWindows.size === 1) {
    issues.push(
      `Windows were only found on the ${[...wallsWithWindows][0]} wall — check the adjacent walls again for glazing, daylight, reveals or blinds.`,
    );
  }

  const floor = (r.surfaces ?? []).find((s) => `${s.kind}`.toLowerCase().includes("floor"));
  if (floor && w > 0 && l > 0) {
    const expect = w * l;
    const got = num(floor.area_m2, 0) ?? 0;
    if (got > 0 && (got > expect * 1.5 || got < expect * 0.5)) {
      issues.push(
        `Floor area ${got} m2 disagrees with ${expect.toFixed(1)} m2 implied by the dimensions.`,
      );
    }
  }

  // Each named wall surface must agree with the shell it belongs to. A wall
  // area that disagrees is usually a sign the run itself was mis-scaled.
  if (w > 0 && l > 0 && h > 0) {
    for (const s of r.surfaces ?? []) {
      const text = `${s.kind} ${s.name}`.toLowerCase();
      if (!/wall/.test(text)) continue;
      const run = /north|south/.test(text) ? w : /east|west/.test(text) ? l : 0;
      if (!run) continue;
      const expect = run * h;
      const got = num(s.area_m2, 0) ?? 0;
      if (got > 0 && (got > expect * 1.4 || got < expect * 0.6)) {
        issues.push(
          `${s.name} is listed at ${got} m2 but a ${run.toFixed(2)} m run at ${h} m high is ${expect.toFixed(1)} m2 — reconcile the wall run with the room dimensions.`,
        );
      }
    }
  }

  // A plausible shell is roughly rectangular in habitable proportions.
  if (w > 0 && l > 0) {
    const ratio = Math.max(w, l) / Math.min(w, l);
    if (ratio > 4) {
      issues.push(
        `The shell is ${w} m x ${l} m, a ${ratio.toFixed(1)}:1 corridor. Confirm that proportion against the frames or re-derive the shorter run.`,
      );
    }
    if (Math.min(w, l) < 1.5) {
      issues.push(`The shorter room run is only ${Math.min(w, l)} m — re-check the scale anchor.`);
    }
  }

  if (acousticVolumeM3 && w > 0 && l > 0 && h > 0) {
    const visual = w * l * h;
    const ratio = visual / acousticVolumeM3;
    if (ratio > 2.5 || ratio < 0.4) {
      issues.push(
        `Visual volume ${visual.toFixed(1)} m3 disagrees with the acoustic estimate ${acousticVolumeM3.toFixed(1)} m3 (ratio ${ratio.toFixed(2)}). Re-check the scale anchor.`,
      );
    }
  }

  if (reflectionDistanceM && w > 0 && l > 0) {
    const nearestWall = Math.min(w, l) / 2;
    if (reflectionDistanceM > nearestWall * 2 || reflectionDistanceM < nearestWall * 0.4) {
      issues.push(
        `Measured first-reflection distance ${reflectionDistanceM} m disagrees with the nearest wall at ${nearestWall.toFixed(2)} m from the room center.`,
      );
    }
  }

  // Wall contact: large furniture floating in open floor is the single most
  // common reconstruction error.
  const WALL_ITEMS =
    /sofa|couch|settee|piano|bed|bookcase|bookshelf|shelf|sideboard|wardrobe|cabinet|dresser|desk|tv|television|credenza|console|mantel|mantle|beam|clock|mirror/i;
  for (const o of r.objects ?? []) {
    if (!WALL_ITEMS.test(String(o.label ?? ""))) continue;
    const x = num(o.x_m, 0) ?? 0;
    const y = num(o.y_m, 0) ?? 0;
    const d = num(o.depth_m, 0.5) ?? 0.5;
    const gap = Math.min(w / 2 - Math.abs(x), l / 2 - Math.abs(y)) - d / 2;
    if (w > 0 && l > 0 && gap > 0.35) {
      issues.push(
        `"${o.label}" sits ${gap.toFixed(2)} m clear of the nearest wall — furniture of this type is normally back to the wall. Set against_wall and reposition unless the photos show floor behind it.`,
      );
    }
  }

  if ((r.portals ?? []).length === 0) {
    issues.push(
      "No portals were found at all — every room has at least a door. Re-walk all four walls.",
    );
  }

  return issues;
}

export function num(v: unknown, fallback: number | null = null) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
