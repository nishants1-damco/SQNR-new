// Room volume from a measured reverberation time. `volumeFromRt60` is copied
// unchanged from the browser-only `src/lib/acoustics.ts`, because the
// analysis uses it as a cross-check; the browser module should import it
// from here when it moves to apps/web.

export type RoomHardness = "very soft" | "soft" | "mixed" | "live" | "very live";

export function volumeFromRt60(rt60: number, hardness: RoomHardness) {
  if (!rt60 || rt60 <= 0) return null;
  const alpha =
    hardness === "very soft"
      ? 0.45
      : hardness === "soft"
        ? 0.3
        : hardness === "mixed"
          ? 0.2
          : hardness === "live"
            ? 0.12
            : 0.07;
  // V = RT60 * S * alpha / 0.161, with S approximated from V for a cubic-ish
  // room: S ≈ 6 * V^(2/3). Solving gives V = (RT60 * 6 * alpha / 0.161)^3.
  const v = Math.pow((rt60 * 6 * alpha) / 0.161, 3);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(Math.max(v, 4), 20000) * 10) / 10;
}
