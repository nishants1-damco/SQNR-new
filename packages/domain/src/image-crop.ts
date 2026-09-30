// Cropping objects out of full-resolution frames for the zoom-in verification
// pass. Pure JavaScript (jpeg-js): the server runs on Cloudflare Workers, which
// has no native image library.
//
// Decoding a 1920 px frame costs ~100 ms of CPU, so callers decode each frame
// once and cut every object they need from it.

import { decode, encode } from "jpeg-js";

/** Normalized box: 0 = left/top edge, 1 = right/bottom edge. */
export interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface CropOptions {
  /** Context kept around the box, as a fraction of the box size per side. */
  padding?: number;
  /** Crops smaller than this (px) grow around their center, so tiny boxes keep context. */
  minEdgePx?: number;
  /** Longer crops are downscaled to this (px) to bound image tokens. */
  maxEdgePx?: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const img = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 25 });
  return { width: img.width, height: img.height, data: img.data };
}

export function encodeJpeg(img: RgbaImage, quality = 85): Uint8Array {
  return new Uint8Array(encode(img, quality).data);
}

/** Pixel rectangle for a normalized box, padded, grown to a minimum size and clamped. */
export function boxToPixels(
  box: NormalizedBox,
  width: number,
  height: number,
  { padding = 0.15, minEdgePx = 160 }: CropOptions = {},
): { x: number; y: number; w: number; h: number } {
  let x0 = Math.min(clamp01(box.x0), clamp01(box.x1)) * width;
  let x1 = Math.max(clamp01(box.x0), clamp01(box.x1)) * width;
  let y0 = Math.min(clamp01(box.y0), clamp01(box.y1)) * height;
  let y1 = Math.max(clamp01(box.y0), clamp01(box.y1)) * height;
  const padX = (x1 - x0) * padding;
  const padY = (y1 - y0) * padding;
  x0 -= padX;
  x1 += padX;
  y0 -= padY;
  y1 += padY;
  const grow = (lo: number, hi: number, limit: number) => {
    const size = Math.min(Math.max(hi - lo, minEdgePx), limit);
    const center = (lo + hi) / 2;
    const start = Math.min(Math.max(center - size / 2, 0), limit - size);
    return [Math.round(start), Math.round(size)] as const;
  };
  const [x, w] = grow(x0, x1, width);
  const [y, h] = grow(y0, y1, height);
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
}

/** Cut a region out of a decoded image, box-averaging it down to `maxEdgePx`. */
export function cropRegion(img: RgbaImage, box: NormalizedBox, opts: CropOptions = {}): RgbaImage {
  const { x, y, w, h } = boxToPixels(box, img.width, img.height, opts);
  const maxEdge = opts.maxEdgePx ?? 768;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = y + Math.floor((oy * h) / outH);
    const sy1 = Math.max(sy0 + 1, y + Math.floor(((oy + 1) * h) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = x + Math.floor((ox * w) / outW);
      const sx1 = Math.max(sx0 + 1, x + Math.floor(((ox + 1) * w) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.data[i] ?? 0;
          g += img.data[i + 1] ?? 0;
          b += img.data[i + 2] ?? 0;
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}
