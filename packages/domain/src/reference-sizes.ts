// Real-world sizes the reconstruction can scale from and sanity-check
// against. Deliberately country-neutral: the app mainly scans conference and
// meeting rooms in offices worldwide, and building standards differ between
// countries and organizations, so these are ranges, not any one standard.
// The model is told to prefer what it can count and measure in the frames.
//
// Pure module: safe in tests.

const LINES = [
  "Doors: single leaves ~0.8-1.0 m wide, double doors ~1.6-2.0 m; door heights ~2.0-2.4 m (commercial doors often run taller than residential ones).",
  "Ceilings: meeting rooms and offices ~2.5-3.3 m, homes ~2.4-3.1 m. Suspended ceilings use square tiles of roughly 0.6 m, or rectangular 0.6 x 1.2 m panels.",
  "Floors: carpet tiles ~0.5-0.6 m square; raised-floor panels ~0.6 m; hard floor tiles ~0.3-0.6 m or 0.6 x 1.2 m.",
  "Tables: tops ~0.72-0.76 m high; meeting tables ~0.9-1.5 m wide, with ~0.6-0.75 m of edge per seat along their length.",
  "Chairs: seat height ~0.42-0.5 m; office and meeting chairs ~0.55-0.7 m wide, ~0.9-1.1 m tall.",
  "Displays (16:9, width without bezel): 55 in ~1.22 m, 65 in ~1.44 m, 75 in ~1.66 m, 85 in ~1.88 m, 98 in ~2.17 m; usually mounted with the screen center ~1.2-1.5 m above the floor.",
  "AV: video bars ~0.6-1.1 m wide and ~0.1 m tall; ceiling microphone arrays ~0.6 m square; wall or table touch panels ~0.2-0.3 m.",
  "Other: whiteboards ~1.2 x 0.9 m to 2.4 x 1.2 m; glass partition panels ~1.0-1.5 m wide; credenzas ~0.75-0.8 m high; 3-seat sofas ~1.8-2.2 m wide.",
];

/** The reference-sizes block included in every analysis step's context. */
export const REFERENCE_SIZES_PROMPT = [
  "REFERENCE SIZES (typical ranges; sizes vary by country and organization, so prefer what you can count and measure in the frames):",
  ...LINES.map((l) => `- ${l}`),
].join("\n");
