// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5 (ADR-0004). Stage-2 structural verification. A
// pHash/CLIP candidate is NEVER consolidated on Stage-1 alone — we confirm two
// assets are the SAME shot (a re-save / re-encode / RAW+JPEG of one frame) with
// a windowed SSIM over their decoded pixels. A crop or a distinct burst frame
// scores low and is therefore NOT consolidated (we keep it), which is exactly
// the safe behaviour: structural equivalence guards against destroying content.
//
// `ssim` is pure (unit-tested); `structuralSimilarity` is the only sharp-using
// part.

import sharp from "sharp";
import { singleChannel } from "./quality";

const C1 = (0.01 * 255) ** 2; // 6.5025
const C2 = (0.03 * 255) ** 2; // 58.5225
const WINDOW = 8;

/** SSIM above this ⇒ the same shot ⇒ safe to treat as a consolidation variant. */
export const SSIM_VARIANT_GATE = 0.92;

/**
 * Mean windowed SSIM between two equal-size 8-bit greyscale images. Non-
 * overlapping 8×8 windows; per-window SSIM averaged. Returns 1.0 for identical
 * input, ~0 for unrelated. Pure.
 */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (a.length !== b.length || width < WINDOW || height < WINDOW) {
    return a.length === b.length && a.every((v, i) => v === b[i]) ? 1 : 0;
  }
  let total = 0;
  let windows = 0;
  for (let wy = 0; wy + WINDOW <= height; wy += WINDOW) {
    for (let wx = 0; wx + WINDOW <= width; wx += WINDOW) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      const nPix = WINDOW * WINDOW;
      for (let y = 0; y < WINDOW; y++) {
        const row = (wy + y) * width + wx;
        for (let x = 0; x < WINDOW; x++) {
          const va = a[row + x];
          const vb = b[row + x];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const muA = sa / nPix;
      const muB = sb / nPix;
      const varA = saa / nPix - muA * muA;
      const varB = sbb / nPix - muB * muB;
      const covAB = sab / nPix - muA * muB;
      const num = (2 * muA * muB + C1) * (2 * covAB + C2);
      const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      total += den === 0 ? 1 : num / den;
      windows++;
    }
  }
  return windows > 0 ? total / windows : 0;
}

/**
 * Decode two preview buffers to a common 256×256 greyscale grid and return their
 * windowed SSIM. `fit:"fill"` normalises dimensions: same-framing re-saves stay
 * aligned (high SSIM); a crop's different framing distorts → low SSIM → it is
 * correctly NOT confirmed as a consolidation variant. I/O.
 */
export async function structuralSimilarity(bufA: Buffer, bufB: Buffer): Promise<number> {
  const SIZE = 256;
  const decode = (buf: Buffer) =>
    sharp(buf, { failOn: "none" })
      .resize(SIZE, SIZE, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
  const [ga, gb] = await Promise.all([decode(bufA), decode(bufB)]);
  const a = singleChannel(ga.data, ga.info.channels);
  const b = singleChannel(gb.data, gb.info.channels);
  return ssim(a, b, SIZE, SIZE);
}
