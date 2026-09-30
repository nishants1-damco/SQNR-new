// What a scan's rows say before any model looks at it: frame poses, sensor
// trust, acoustics, imported depth, walked and ranged shells, and the context
// text every pass receives. Ported from the start of `analyzeScan`
// (`src/lib/scan.functions.ts`). Pure.
import { describeWalkedShell, type WalkedShell, type WalkLeg } from "@spatial/domain/walk-legs";
import { REFERENCE_SIZES_PROMPT } from "@spatial/domain/reference-sizes";
import { type RoomHardness, volumeFromRt60 } from "@spatial/domain/room-acoustics";
import { acousticsReliable, isTrustedPose } from "@spatial/domain/sensor-trust";
import {
  describeMeasuredShell,
  type MeasuredShell,
  shellFromRanges,
  type WallRange,
} from "@spatial/domain/wall-ranges";
import { num } from "./plan-geometry";
import type { AnalysisPhoto } from "./types";

export interface ScanRow {
  id: string;
  user_id: string;
  name: string;
  notes: string | null;
  status: string;
  acoustics: Record<string, unknown>;
  analysis_notes: Record<string, unknown>;
  depth_metrics: Record<string, unknown>;
  depth_source: string | null;
}

export interface PhotoRow {
  id: string;
  idx: number;
  storage_path: string;
  thumbnail_path: string | null;
  heading_deg: number | null;
  captured_at: string;
  sensor_payload: Record<string, unknown>;
}

/**
 * Inertial track: each frame carries the phone's displacement from frame 0,
 * measured on-device by accelerometer + gyro. That baseline is what keeps
 * scale consistent across the whole sweep instead of every frame being
 * treated as if it were shot from the same spot.
 */
export function posedPhotos(photos: PhotoRow[]): AnalysisPhoto[] {
  return photos.map((p) => {
    const sp = (p.sensor_payload ?? {}) as {
      pose?: Record<string, unknown> | null;
      fov_deg?: unknown;
      ultra_wide?: unknown;
      station?: unknown;
      station_kind?: unknown;
      view?: unknown;
      quality?: { sharpness?: unknown } | null;
    };
    const pose = sp.pose ?? null;
    const px = num(pose?.["x"], null);
    const py = num(pose?.["y"], null);
    return {
      path: p.storage_path,
      heading_deg: p.heading_deg == null ? null : Number(p.heading_deg),
      captured_at: p.captured_at,
      // Frames captured before lens selection carry no FOV; the narrow rear
      // camera is the correct assumption for those.
      fov_deg: num(sp.fov_deg, null),
      ultra_wide: sp.ultra_wide === true,
      station: num(sp.station, null),
      station_kind: typeof sp.station_kind === "string" ? sp.station_kind : null,
      view: sp.view === "low" ? ("low" as const) : ("level" as const),
      sharpness: num(sp.quality?.sharpness, null),
      pose:
        px == null || py == null
          ? null
          : {
              x: px,
              y: py,
              z: num(pose?.["z"], 0) ?? 0,
              drift_m: num(pose?.["drift_m"], null),
              motion_energy: num(pose?.["motion_energy"], null),
            },
    };
  });
}

export interface ScanInputs {
  posed: AnalysisPhoto[];
  /** Distinct standing positions. One means a single spin, which can't recover scale. */
  stationCount: number;
  /** Poses with little estimated drift: only those count as evidence. */
  stations: NonNullable<AnalysisPhoto["pose"]>[];
  spanEast: number;
  spanNorth: number;
  acoustics: Record<string, unknown> | null;
  reflectionDistance: number | null;
  acousticVolume: number | null;
  measuredShell: { width: number; length: number; height: number } | null;
  wallRanges: WallRange[];
  rangedShell: MeasuredShell | null;
  walkLegs: WalkLeg[];
  walkedShell: (WalkedShell & { basis: string }) | null;
  stationSeeds: { x: number; y: number }[];
}

export function scanInputs(scan: ScanRow, photos: PhotoRow[]): ScanInputs {
  const posed = posedPhotos(photos);
  const stationCount = new Set(posed.map((p) => p.station).filter((s): s is number => s != null))
    .size;
  const stations = posed
    .map((p) => p.pose)
    .filter((p): p is NonNullable<typeof p> => isTrustedPose(p));
  const spanEast = stations.length
    ? Math.max(...stations.map((s) => s.x)) - Math.min(...stations.map((s) => s.x))
    : 0;
  const spanNorth = stations.length
    ? Math.max(...stations.map((s) => s.y)) - Math.min(...stations.map((s) => s.y))
    : 0;

  const acoustics = scan.acoustics as Record<string, unknown> | null;
  const rt60 = num(acoustics?.["rt60_s"], null);
  // A noisy or inconsistent probe says little about the room: skip its
  // volume and reflection cross-checks rather than mislead the model.
  const acousticsTrusted = acousticsReliable(acoustics);
  const reflectionDistance = acousticsTrusted
    ? num(acoustics?.["reflection_distance_m"], null)
    : null;
  const acousticVolume =
    acousticsTrusted && rt60 && rt60 > 0
      ? volumeFromRt60(rt60, (acoustics?.["hardness"] as RoomHardness | undefined) ?? "mixed")
      : null;

  const depth = scan.depth_metrics ?? {};
  const dW = num(depth["width_m"], null);
  const dL = num(depth["length_m"], null);
  const dH = num(depth["height_m"], null);

  // Acoustic ranging: time-of-flight chirps fired at the four cardinal walls
  // during the sweep. Unlike a visual scale anchor these are measurements, so
  // they constrain the shell rather than merely informing it.
  const notes = scan.analysis_notes ?? {};
  const wallRanges = Array.isArray(notes["wall_ranges"])
    ? (notes["wall_ranges"] as WallRange[])
    : [];
  const walkLegs = Array.isArray(notes["walk_legs"]) ? (notes["walk_legs"] as WalkLeg[]) : [];

  // Walked perimeter: legs integrated between corner anchors during capture.
  const walkedShell = (() => {
    const raw = notes["walked_shell"] as Record<string, unknown> | undefined;
    if (!raw) return null;
    const w = num(raw["width_m"], null);
    const l = num(raw["length_m"], null);
    if (!w || !l) return null;
    return {
      width_m: w,
      length_m: l,
      closure_error_m: num(raw["closure_error_m"], 0) ?? 0,
      tolerance: num(raw["tolerance"], 0.1) ?? 0.1,
      quality: num(raw["quality"], 0) ?? 0,
      legs: Array.isArray(raw["legs"]) ? (raw["legs"] as WalkLeg[]) : [],
      basis: String(raw["basis"] ?? "walked perimeter"),
    } as WalkedShell & { basis: string };
  })();

  return {
    posed,
    stationCount,
    stations,
    spanEast,
    spanNorth,
    acoustics,
    reflectionDistance,
    acousticVolume,
    measuredShell: dW && dL && dH ? { width: dW, length: dL, height: dH } : null,
    wallRanges,
    rangedShell: wallRanges.length ? shellFromRanges(wallRanges) : null,
    walkLegs,
    walkedShell,
    stationSeeds: Array.isArray(notes["station_seeds"])
      ? (notes["station_seeds"] as { x: number; y: number }[])
      : [],
  };
}

/** The context every pass receives, ahead of the frames. */
export function buildContextText(scan: ScanRow, inputs: ScanInputs, frameCount: number): string {
  const { acoustics, measuredShell: m, walkedShell, rangedShell, stations } = inputs;
  return [
    REFERENCE_SIZES_PROMPT,
    `Space label provided by the person capturing: "${scan.name}".`,
    scan.notes ? `Their notes: ${scan.notes}` : "",
    m
      ? `Measured ground truth from an imported ${scan.depth_source ?? "depth"} scan: the room shell is ${m.width} m x ${m.length} m with a ceiling at ${m.height} m. These three numbers are surveyed, not estimated, so use them exactly as width_m, length_m and height_m and fit every object and portal inside that shell rather than correcting them from the photos.`
      : scan.depth_source
        ? `A depth/LiDAR capture was imported from ${scan.depth_source}; treat dimensions as measured rather than guessed where photos agree.`
        : "No depth capture available. Estimate dimensions from the imagery.",
    acoustics && Object.keys(acoustics).length
      ? `Measured acoustics: ${JSON.stringify({
          rt60_s: acoustics["rt60_s"],
          chirps: acoustics["chirps"],
          chirp_rt60_s: acoustics["chirp_rt60_s"],
          rt60_spread_s: acoustics["rt60_spread_s"],
          first_reflection_ms: acoustics["first_reflection_ms"],
          reflection_distance_m: acoustics["reflection_distance_m"],
          noise_floor_db: acoustics["noise_floor_db"],
          clarity_index: acoustics["clarity_index"],
          brightness: acoustics["brightness"],
          bands_db: acoustics["bands_db"],
          hardness: acoustics["hardness"],
        })}`
      : "No acoustic measurement captured.",
    inputs.acousticVolume
      ? `Rough inverse-Sabine volume estimate from the measured RT60: ~${inputs.acousticVolume} m3. Phone acoustics are often off by a factor of two or more; use it as a cross-check only.`
      : "",
    inputs.reflectionDistance
      ? `Measured first-reflection distance: ~${inputs.reflectionDistance} m from the phone (held near the room center) to the nearest large surface, which may be a wall or a large piece of furniture. Use it as a sanity check, not a constraint.`
      : "",
    walkedShell && !m ? describeWalkedShell(walkedShell) : "",
    walkedShell && rangedShell && !m
      ? "The walked measurement above outranks the acoustic one: use it for width and length."
      : "",
    rangedShell && !m ? describeMeasuredShell(rangedShell) : "",
    inputs.stationCount > 1
      ? `Multi-viewpoint capture: the frames come from ${inputs.stationCount} standing positions, labeled in each frame caption, a few meters apart. The same object seen from two viewpoints at different bearings can be triangulated: use that, not a guess, to place it. If two viewpoints disagree about where something is, say so in your notes rather than averaging them into the middle of the floor.`
      : "",
    stations.length >= 3
      ? `Inertial track: ${stations.length} frames carry a displacement from frame 0 with low estimated drift (accelerometer and gyro dead reckoning). The capture path spans ${inputs.spanEast.toFixed(2)} m east-west and ${inputs.spanNorth.toFixed(2)} m north-south, so the room is at least that large on each axis; use these offsets as supporting evidence when triangulating positions.`
      : "No inertial track available for these frames. Rely on visual scale anchors.",
    `${frameCount} photo frames follow, in capture order.`,
  ]
    .filter(Boolean)
    .join("\n");
}
