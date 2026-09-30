// Graph solve: stations and landmarks optimized together. Walked legs are
// metric but drift; bearings are precise in angle but have no scale. Solving
// both at once lets a well-seen corner correct a bad leg instead of the room
// inheriting its error. Ported from `analyzeScan`. Pure and cheap, so it is
// recomputed on resume rather than checkpointed.
import { shellFromSolve, solveGraph } from "@spatial/domain/graph-solve";
import {
  consolidate,
  describeSolvedLandmarks,
  type RawSighting,
  sharedLandmarks,
  sightingsToBearings,
} from "@spatial/domain/landmarks";
import type { FrameInfo } from "./passes";
import { num } from "./plan-geometry";
import type { ScanInputs } from "./scan-inputs";

export function solveRoomGraph(inputs: ScanInputs, frames: FrameInfo[], sightings: RawSighting[]) {
  const { stationSeeds, walkLegs, wallRanges } = inputs;
  const bearings = consolidate(sightingsToBearings(sightings, frames));
  const shared = sharedLandmarks(bearings);
  const observedStationIds = new Set(
    frames.map((frame) => frame.station).filter((station): station is number => station != null),
  );
  const stationDataAligned =
    stationSeeds.length >= 2 &&
    observedStationIds.size === stationSeeds.length &&
    [...observedStationIds].every((station) => station >= 0 && station < stationSeeds.length);
  const solved =
    stationDataAligned && shared.length >= 2
      ? solveGraph({
          stations: stationSeeds,
          odometry: walkLegs.map((leg, i) => {
            const l = leg as unknown as Record<string, unknown>;
            return {
              from: i,
              to: i + 1,
              dx: num(l["dx"], 0) ?? 0,
              dy: num(l["dy"], 0) ?? 0,
              weight: num(l["quality"], 0.5) ?? 0.5,
            };
          }),
          bearings,
          ranges: wallRanges
            .filter((r) => Number.isFinite(r.distance_m) && Number.isFinite(r.heading_deg))
            .map((r) => ({
              station: Number.isFinite(r.station) ? Number(r.station) : 0,
              bearing_deg: Number(r.heading_deg),
              distance_m: r.distance_m,
              weight: 0.5,
            })),
        })
      : null;
  const solvedShell = solved ? shellFromSolve(solved) : null;
  const solvedText = solved
    ? [
        describeSolvedLandmarks(
          solved.landmarks.filter((l) => l.sightings >= 2),
          solved.bearing_residual_deg,
        ),
        solvedShell && solvedShell.quality >= 0.3
          ? `The triangulated architecture implies a room ${solvedShell.width_m} m east-west by ${solvedShell.length_m} m north-south. This is a geometric measurement from ${solved.basis}. Prefer it over any visual size estimate unless a surveyed depth import contradicts it.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return { solved, solvedShell, solvedText, stationDataAligned, observedStationIds };
}

export type RoomGraph = ReturnType<typeof solveRoomGraph>;
