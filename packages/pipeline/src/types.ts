// Shapes shared by the passes, the runner and persistence, ported from
// `src/lib/scan-analysis.server.ts`.

export interface FramePose {
  x: number;
  y: number;
  z: number;
  drift_m?: number | null;
  motion_energy?: number | null;
}

export interface AnalysisPhoto {
  path: string;
  heading_deg: number | null;
  captured_at: string;
  /** Inertial pose of the phone relative to frame 1 (+x east, +y north). */
  pose?: FramePose | null;
  /** Estimated horizontal field of view of the lens that took the frame. */
  fov_deg?: number | null;
  /** True when shot on the ultra-wide (0.5x) module. */
  ultra_wide?: boolean | null;
  /** Index of the standing position this frame was shot from, if any. */
  station?: number | null;
  /** "corner" or "center" for a multi-station capture. */
  station_kind?: string | null;
  /** "low" for the downward view taken at each corner. */
  view?: "level" | "low" | null;
  /** Laplacian variance from capture; higher is sharper. */
  sharpness?: number | null;
}

export interface AnalysisResult {
  name: string;
  summary: string;
  width_m: number;
  length_m: number;
  height_m: number;
  scale_reference?: string;
  dimension_confidence?: {
    width?: number;
    length?: number;
    height?: number;
    overall?: number;
    basis?: string;
  };
  revision_notes?: string[];
  wall_evidence?: {
    wall: string;
    run_class: "long" | "short";
    landmarks_in_order: string[];
    supporting_headings_deg: number[];
  }[];
  objects: {
    label: string;
    category: string;
    confidence: number;
    x_m: number;
    y_m: number;
    width_m: number;
    depth_m: number;
    height_m: number;
    material?: string;
    /** Wall the object's back is against: north | east | south | west | none. */
    against_wall?: string;
    /** Rotation of the object's front face, degrees clockwise from north. */
    yaw_deg?: number;
    /** Object center measured along its wall using the same fixed origin as portals. */
    wall_offset_m?: number;
    /** Headings of the frames that independently support this placement. */
    supporting_headings_deg?: number[];
    /** Bottom of the object above the floor, for wall-mounted/elevated items. */
    floor_elevation_m?: number;
    /** Another detected object that anchors this object's relative placement. */
    relative_to?: string;
    spatial_relation?: "in_front_of" | "above" | "below" | "beside" | "none";
  }[];

  surfaces: {
    name: string;
    kind: string;
    material: string;
    area_m2: number;
    absorption: number;
    reflectivity: number;
    color_hex: string;
    notes: string;
  }[];
  portals: {
    kind: string;
    wall: string;
    offset_m: number;
    width_m: number;
    height_m: number;
    /** Bottom edge above the floor: 0 for doors and open thresholds. */
    sill_m?: number;

    confidence: number;
    notes: string;
  }[];
}

export interface ObjectInventoryResult {
  objects: AnalysisResult["objects"];
}
