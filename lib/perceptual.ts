// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Perceptual hashing (pHash) and dominant-color palette extraction.
 *
 * pHash:
 *   1. Resize image to 32x32 grayscale.
 *   2. Apply DCT-II to the 32x32 luminance matrix.
 *   3. Take the top-left 8x8 DCT coefficients (low-frequency block).
 *   4. Compute the median of the 64 coefficients (excluding the DC term).
 *   5. Build a 64-bit hash where bit i = 1 if coef[i] > median, else 0.
 *
 * Hamming distance ≤ 5 means "near-duplicate" with low false-positive rate.
 *
 * Color palette:
 *   1. Resize image to 100x100 RGB.
 *   2. K-means quantize the 10,000 pixels into 8 clusters.
 *   3. Return [{ hex, weight }] sorted by weight desc, weights summing to 1.
 *
 * For videos, the caller is responsible for extracting the first frame and
 * passing a still image buffer to these functions. Sharp can't decode video,
 * so the upload pipeline simply skips pHash/colors for non-image MIME types.
 */

import sharp from "sharp";

/* ─── pHash ─────────────────────────────────────────────────────────── */

const PHASH_DCT_SIZE = 32;
const PHASH_HASH_SIZE = 8; // top-left 8x8 of DCT coefficients

// Precomputed DCT-II coefficient matrix for size 32.
// dctMatrix[k][n] = sqrt(2/N) * cos(((2n+1) * k * pi) / (2N)),
// with the k=0 row scaled by 1/sqrt(2).
const DCT_MATRIX: number[][] = (() => {
  const N = PHASH_DCT_SIZE;
  const m: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  const c0 = Math.sqrt(1 / N);
  const c = Math.sqrt(2 / N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      const v = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
      m[k][n] = (k === 0 ? c0 : c) * v;
    }
  }
  return m;
})();

/**
 * Apply DCT-II to a flat NxN row-major matrix and return the result.
 * Result is also row-major, same dimensions.
 */
function dct2d(input: Float64Array, N: number): Float64Array {
  // Row pass: temp[i][k] = sum_n DCT_MATRIX[k][n] * input[i][n]
  const temp = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      let sum = 0;
      const rowI = i * N;
      for (let n = 0; n < N; n++) sum += DCT_MATRIX[k][n] * input[rowI + n];
      temp[rowI + k] = sum;
    }
  }
  // Column pass: out[k][j] = sum_i DCT_MATRIX[k][i] * temp[i][j]
  const out = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += DCT_MATRIX[k][i] * temp[i * N + j];
      out[k * N + j] = sum;
    }
  }
  return out;
}

/**
 * Compute the 64-bit perceptual hash of an image buffer.
 *
 * Returns the hash as a `bigint` so it can be stored verbatim in a Postgres
 * `bigint` column without losing the high bit.
 *
 * Throws if the buffer can't be decoded by sharp (caller should catch and
 * skip pHash for that asset).
 */
export async function computePHash(buffer: Buffer): Promise<bigint> {
  const N = PHASH_DCT_SIZE;

  // Resize to 32x32 grayscale, raw pixels.
  const { data } = await sharp(buffer)
    .resize(N, N, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (data.length !== N * N) {
    throw new Error(`pHash: expected ${N * N} bytes, got ${data.length}`);
  }

  // Promote to Float64 for DCT.
  const pixels = new Float64Array(N * N);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i];

  const dct = dct2d(pixels, N);

  // Extract the top-left 8x8 block (excluding DC at [0,0]).
  const H = PHASH_HASH_SIZE;
  const block = new Float64Array(H * H);
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < H; j++) {
      block[i * H + j] = dct[i * N + j];
    }
  }
  // Compute median over the block excluding the DC term.
  const sorted = Array.from(block.slice(1)).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  // Build the 64-bit hash. bit position i = 1 if block[i] > median.
  let hash = 0n;
  for (let i = 0; i < H * H; i++) {
    if (block[i] > median) hash |= 1n << BigInt(i);
  }
  return hash;
}

/**
 * Hamming distance between two 64-bit pHashes. 0 = identical, 64 = inverted.
 * Inputs are the canonical UNSIGNED 64-bit BigInt produced by computePHash().
 * If you read a phash back from Postgres (signed bigint), normalise it with
 * `phashFromDb()` first.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/* ─── Postgres I/O boundary ─────────────────────────────────────────────
 *
 * `computePHash()` returns an UNSIGNED 64-bit BigInt (0 .. 2^64 - 1). The
 * `assets.phash` column is Postgres BIGINT, which is SIGNED int8 (-2^63 ..
 * 2^63 - 1). For ~50% of images the top bit is set and the unsigned value
 * overflows signed int8, causing the INSERT to fail with "bigint out of
 * range" / "value too large".
 *
 * Round-trip via two's-complement: values >= 2^63 map to a negative signed
 * representation. The bit pattern is identical, so XOR-based Hamming
 * distance still works as long as both sides use the same convention.
 */
const TWO_POW_63 = 1n << 63n;
const TWO_POW_64 = 1n << 64n;

/** Unsigned 64-bit pHash → signed BIGINT for Postgres storage. */
export function phashToDb(unsigned: bigint): bigint {
  return unsigned >= TWO_POW_63 ? unsigned - TWO_POW_64 : unsigned;
}

/** Signed BIGINT from Postgres → unsigned 64-bit pHash for in-process math. */
export function phashFromDb(signed: bigint): bigint {
  return signed < 0n ? signed + TWO_POW_64 : signed;
}

/* ─── Color palette ─────────────────────────────────────────────────── */

const PALETTE_SIZE = 8;
const PALETTE_RESIZE = 100;
const KMEANS_MAX_ITERATIONS = 16;
const KMEANS_CONVERGENCE_THRESHOLD = 1.0; // total centroid drift in RGB space

export interface PaletteColor {
  hex: string;
  weight: number; // [0, 1]
}

/**
 * Extract a representative palette of dominant colors from an image.
 *
 * Returns up to PALETTE_SIZE colors sorted by weight (descending).
 * Weights sum to 1.0.
 */
export async function extractPalette(buffer: Buffer): Promise<PaletteColor[]> {
  const { data, info } = await sharp(buffer)
    .resize(PALETTE_RESIZE, PALETTE_RESIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  if (channels < 3) return [];

  const pixelCount = info.width * info.height;
  const pixels: number[][] = [];
  for (let i = 0; i < pixelCount; i++) {
    const o = i * channels;
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }

  // Initialize centroids deterministically by stride-sampling — cheaper than
  // k-means++ and works well enough for 8 clusters in RGB space.
  const k = Math.min(PALETTE_SIZE, pixels.length);
  const stride = Math.max(1, Math.floor(pixels.length / k));
  const centroids: number[][] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.min(i * stride, pixels.length - 1);
    centroids.push([...pixels[idx]]);
  }

  const assignments = new Int32Array(pixels.length);

  for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
    // Assign each pixel to the nearest centroid (squared Euclidean in RGB).
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const cc = centroids[c];
        const dr = p[0] - cc[0];
        const dg = p[1] - cc[1];
        const db = p[2] - cc[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assignments[i] = best;
    }

    // Recompute centroids and track total drift.
    const sums: number[][] = Array.from({ length: centroids.length }, () => [0, 0, 0]);
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < pixels.length; i++) {
      const c = assignments[i];
      const p = pixels[i];
      sums[c][0] += p[0];
      sums[c][1] += p[1];
      sums[c][2] += p[2];
      counts[c]++;
    }

    let drift = 0;
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      const nr = sums[c][0] / counts[c];
      const ng = sums[c][1] / counts[c];
      const nb = sums[c][2] / counts[c];
      drift += Math.abs(nr - centroids[c][0])
        + Math.abs(ng - centroids[c][1])
        + Math.abs(nb - centroids[c][2]);
      centroids[c] = [nr, ng, nb];
    }
    if (drift < KMEANS_CONVERGENCE_THRESHOLD) break;
  }

  // Build palette weighted by cluster size.
  const counts = new Int32Array(centroids.length);
  for (let i = 0; i < assignments.length; i++) counts[assignments[i]]++;

  const palette: PaletteColor[] = [];
  for (let c = 0; c < centroids.length; c++) {
    if (counts[c] === 0) continue;
    const [r, g, b] = centroids[c];
    palette.push({
      hex: rgbToHex(Math.round(r), Math.round(g), Math.round(b)),
      weight: counts[c] / pixels.length,
    });
  }
  palette.sort((a, b) => b.weight - a.weight);
  return palette;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/* ─── Color similarity (Lab ΔE) ─────────────────────────────────────── */

/**
 * Convert sRGB (0..255) to CIE Lab. Uses D65 illuminant.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB → linear
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r);
  const lg = lin(g);
  const lb = lin(b);

  // linear sRGB → XYZ (D65)
  const X = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const Y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const Z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

  // XYZ → Lab. Reference white D65: (0.95047, 1.0, 1.08883).
  const Xn = X / 0.95047;
  const Yn = Y / 1.0;
  const Zn = Z / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(Xn);
  const fy = f(Yn);
  const fz = f(Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIE76 ΔE (Euclidean distance in Lab space). Adequate for "is this color
 * roughly that color" filtering. ΔE ≈ 30 is the threshold for matching
 * "the same hue family" in palette search.
 */
export function deltaE76(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** Parse a #rrggbb (or #rgb) string. Returns null on parse failure. */
export function parseHex(hex: string): [number, number, number] | null {
  const s = hex.trim().replace(/^#/, "");
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  return null;
}
