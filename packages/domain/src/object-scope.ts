// Which detected objects the reconstruction keeps.
//
// The capture targets the room shell, its portals and its major items. Small
// loose clutter adds noise without meaning, so it is dropped — but audio-
// visual, IT and building-control devices are exactly what Room Ready and the
// other downstream apps care about, and many are small (a ceiling microphone,
// a camera, a touch panel). They are always kept, whatever their size.
//
// This module is the single source of truth: the post-processing filter uses
// `keepDetectedObject`, and the prompts include `DEVICE_SCOPE_PROMPT`, so the
// model is never told to skip what the filter keeps (or the reverse).
//
// Pure module: safe in the browser and in tests.

/** AV / IT / building-control devices: always kept, any size. */
export const DEVICE_PHRASES = [
  "aio bar",
  "all in one bar",
  "video bar",
  "videobar",
  "soundbar",
  "sound bar",
  "tv",
  "television",
  "monitor",
  "display",
  "interactive display",
  "interactive whiteboard",
  "digital signage",
  "projector",
  "projection screen",
  "speaker",
  "subwoofer",
  "amplifier",
  "camera",
  "webcam",
  "microphone",
  "mic",
  "touch panel",
  "touch screen",
  "touchscreen",
  "control panel",
  "room controller",
  "scheduling panel",
  "codec",
  "conference phone",
  "speakerphone",
  "access point",
  "router",
  "network switch",
  "equipment rack",
  "av rack",
  "media player",
  "occupancy sensor",
  "thermostat",
];

/** Large furniture and fixed features: always kept. */
const MAJOR_PHRASES = [
  "mirror",
  "mantle",
  "mantel",
  "beam",
  "fireplace",
  "radiator",
  "rug",
  "carpet",
  "curtain",
  "shelf",
  "shelving",
  "bookcase",
  "console",
  "sideboard",
  "cabinet",
  "wardrobe",
  "piano",
  "bench",
  "sofa",
  "couch",
  "armchair",
  "chair",
  "table",
  "desk",
  "bed",
  "stove",
  "fridge",
  "refrigerator",
  "whiteboard",
];

/** Loose clutter: dropped unless the label is also a device or major item. */
const CLUTTER_PHRASES = [
  "book",
  "cushion",
  "pillow",
  "throw",
  "remote",
  "mug",
  "cup",
  "glass",
  "bottle",
  "vase",
  "candle",
  "paper",
  "magazine",
  "cable",
  "wire",
  "toy",
  "ornament",
  "figurine",
  "photo frame",
  "picture frame",
  "frame",
  "clock",
  "coaster",
  "bowl",
  "plate",
  "tray",
  "basket",
  "pot",
  "switch",
  "outlet",
  "socket",
];

/** Objects whose largest dimension is below this are clutter unless listed above. */
const MIN_MAJOR_SIZE_M = 0.5;

/** Lowercase words of `text`, space-padded so phrases match on word boundaries. */
function wordText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** True when a phrase (or its simple plural) appears as whole words. */
function mentions(words: string, phrases: string[]): boolean {
  return phrases.some((p) => words.includes(` ${p} `) || words.includes(` ${p}s `));
}

/** True for AV / IT / building-control devices (always kept, verified first). */
export function isDevice(label: unknown): boolean {
  return mentions(wordText(String(label ?? "")), DEVICE_PHRASES);
}

export function keepDetectedObject(o: {
  label?: unknown;
  width_m?: unknown;
  depth_m?: unknown;
  height_m?: unknown;
}): boolean {
  const words = wordText(String(o.label ?? ""));
  if (mentions(words, DEVICE_PHRASES)) return true;
  if (mentions(words, MAJOR_PHRASES)) return true;
  if (mentions(words, CLUTTER_PHRASES)) return false;
  const size = Math.max(Number(o.width_m) || 0, Number(o.depth_m) || 0, Number(o.height_m) || 0);
  return size >= MIN_MAJOR_SIZE_M;
}

/** Appended to the detection and reconstruction prompts. */
export const DEVICE_SCOPE_PROMPT = `DEVICE SCOPE: report these audio-visual, IT and building-control devices whenever they are visible, whatever their size, each as its own object (a video bar mounted under a display is a separate object from the display), because facilities and AV teams rely on them: ${DEVICE_PHRASES.join(", ")}. Give each its real size; many are small (a ceiling microphone ~0.6 x 0.6 x 0.05 m, a conference camera ~0.3 x 0.15 x 0.1 m, a touch panel ~0.25 x 0.05 x 0.18 m).`;
