// Ported unchanged from `src/llm/analysis-schemas.ts`.
// JSON schemas for Claude's structured outputs (`output_config.format`), one
// per analysis pass. With a schema the reply is guaranteed to parse, so a
// malformed answer can no longer silently turn into "no objects found".
//
// Structured outputs require `additionalProperties: false` on every object and
// don't support numeric/string bounds, so ranges stay in the prompts and in
// the pipeline's own clamping. Every property is required; fields the model
// may not know are nullable instead of optional, so "unknown" stays distinct
// from 0 (e.g. a missing wall_offset_m must not become 0 m from the corner).

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const numType: Schema = { type: "number" };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const arrayOf = (items: Schema): Schema => ({ type: "array", items });
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const WALL = { type: "string", enum: ["north", "east", "south", "west", "none"] };
const RELATION = { type: "string", enum: ["in_front_of", "above", "below", "beside", "none"] };

/** One detected object; matches AnalysisResult["objects"][number]. */
export const OBJECT_ITEM_SCHEMA = object({
  label: str,
  category: str,
  confidence: numType,
  x_m: numType,
  y_m: numType,
  width_m: numType,
  depth_m: numType,
  height_m: numType,
  material: str,
  against_wall: WALL,
  yaw_deg: nullable(numType),
  wall_offset_m: nullable(numType),
  supporting_headings_deg: arrayOf(numType),
  floor_elevation_m: nullable(numType),
  relative_to: nullable(str),
  spatial_relation: RELATION,
});

/**
 * Where an object appears: frame number (from the frame caption) and a tight
 * box in normalized image coordinates (0 = left/top, 1 = right/bottom). Used
 * to crop the object for the zoom-in verification pass.
 */
const FRAME_BOX_SCHEMA = object({
  frame: { type: "integer" },
  x0: numType,
  y0: numType,
  x1: numType,
  y1: numType,
});

/** Inventory detections carry frame boxes; the reconstruction passes don't need them. */
const INVENTORY_ITEM_SCHEMA = object({
  ...(OBJECT_ITEM_SCHEMA["properties"] as Record<string, Schema>),
  frame_boxes: arrayOf(FRAME_BOX_SCHEMA),
});

export const OBJECT_INVENTORY_SCHEMA = object({ objects: arrayOf(INVENTORY_ITEM_SCHEMA) });

/** Zoom-in verification verdicts, one per object shown. */
export const VERIFICATION_SCHEMA = object({
  verdicts: arrayOf(
    object({
      object: { type: "integer" },
      present: { type: "boolean" },
      label: str,
      category: str,
      brand: nullable(str),
      model: nullable(str),
      /** Id of the catalog candidate this is ("C1"), or null. */
      catalog_match: nullable(str),
      confidence: numType,
    }),
  ),
});

export const LANDMARK_SCHEMA = object({
  sightings: arrayOf(
    object({ frame: { type: "integer" }, feature: str, image_x: numType, confidence: numType }),
  ),
});

export const PEOPLE_SCREENER_SCHEMA = object({
  frames_with_people: arrayOf({ type: "integer" }),
});

const SURFACE_SCHEMA = object({
  name: str,
  kind: str,
  material: str,
  area_m2: numType,
  absorption: numType,
  reflectivity: numType,
  color_hex: str,
  notes: str,
});

const PORTAL_SCHEMA = object({
  kind: str,
  wall: str,
  offset_m: numType,
  width_m: numType,
  height_m: numType,
  sill_m: nullable(numType),
  confidence: numType,
  notes: str,
});

const reconstructionProperties: Record<string, Schema> = {
  name: str,
  summary: str,
  width_m: numType,
  length_m: numType,
  height_m: numType,
  scale_reference: str,
  dimension_confidence: object({
    width: numType,
    length: numType,
    height: numType,
    overall: numType,
    basis: str,
  }),
  wall_evidence: arrayOf(
    object({
      wall: { type: "string", enum: ["north", "east", "south", "west"] },
      run_class: { type: "string", enum: ["long", "short"] },
      landmarks_in_order: arrayOf(str),
      supporting_headings_deg: arrayOf(numType),
    }),
  ),
  objects: arrayOf(OBJECT_ITEM_SCHEMA),
  surfaces: arrayOf(SURFACE_SCHEMA),
  portals: arrayOf(PORTAL_SCHEMA),
};

/** Pass 1 reconstruction; matches AnalysisResult. */
export const RECONSTRUCTION_SCHEMA = object(reconstructionProperties);

/** Pass 2 adds the reviewer's revision notes. */
export const CRITIQUE_SCHEMA = object({
  ...reconstructionProperties,
  revision_notes: arrayOf(str),
});
