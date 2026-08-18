// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5 (ADR-0004). Deterministic, Fonto-local quality
// scoring used to pick the CANONICAL of a variant group. Resolution is a
// TIEBREAK ONLY, never the primary signal (a 24 MP blurry re-save must not beat
// a sharp 12 MP original). A Plexo no-reference IQA Tool is an OPTIONAL future
// escalation only if these deterministic metrics prove insufficient — not a
// dependency.
//
// The pixel-math (Laplacian variance, blockiness) + the composite score +
// canonical pick are PURE so they unit-test in isolation; only
// `analyzePreview()` touches sharp.

import sharp from "sharp";

export interface QualityMetrics {
  /** Laplacian-variance sharpness of the preview (higher = sharper). */
  sharpness: number;
  /** 8px-grid blockiness ≈ JPEG compression artefacts (lower = cleaner). */
  artifact: number;
  /** Original bytes ÷ original pixels (higher = less compressed). */
  bytesPerPixel: number;
  /** Original resolution in megapixels (TIEBREAK only). */
  megapixels: number;
  /** 1 = an original ingest, 0.5 = a derived/re-encoded copy. */
  origVsDerived: number;
  /** Composite 0..1 — the canonical is the group member with the MAX score. */
  score: number;
}

export interface QualityInputs {
  sharpness: number;
  artifact: number;
  sizeBytes: number;
  origWidth: number | null;
  origHeight: number | null;
  isOriginal: boolean;
}

// Reference scales for normalisation. Operator-overridable later if a corpus
// needs it; deliberately conservative so the composite stays in [0,1].
const SHARP_REF = 1500; // Laplacian variance of a crisp photo preview.
const BPP_REF = 2.5; // bytes/pixel of a high-quality JPEG.
const W_SHARP = 0.45;
const W_BPP = 0.2;
const W_ARTIFACT = 0.15;
const W_ORIG = 0.2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Laplacian-variance focus measure on an 8-bit single-channel image. Convolves
 * with the 4-neighbour Laplacian and returns the variance of the response — the
 * classic blur metric (flat/blurred → ~0, sharp edges → large). Pure.
 */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      // Welford online variance.
      n++;
      const delta = lap - mean;
      mean += delta / n;
      m2 += delta * (lap - mean);
    }
  }
  return n > 1 ? m2 / n : 0;
}

/**
 * Blockiness: mean abs gradient ACROSS 8px grid boundaries relative to the mean
 * abs gradient everywhere. JPEG quantisation makes 8×8 block edges discontinuous,
 * so a ratio > 1 signals compression artefacts. Returns max(0, ratio − 1). Pure.
 */
export function blockiness(gray: Uint8Array, width: number, height: number): number {
  if (width < 9 || height < 9) return 0;
  let boundarySum = 0;
  let boundaryN = 0;
  let allSum = 0;
  let allN = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const g = Math.abs(gray[y * width + x] - gray[y * width + x - 1]);
      allSum += g;
      allN++;
      if (x % 8 === 0) {
        boundarySum += g;
        boundaryN++;
      }
    }
  }
  if (boundaryN === 0 || allN === 0) return 0;
  const boundaryMean = boundarySum / boundaryN;
  const allMean = allSum / allN;
  if (allMean <= 0) return 0;
  return Math.max(0, boundaryMean / allMean - 1);
}

/** Composite 0..1 quality score from raw metrics. Pure. Resolution excluded. */
export function compositeQualityScore(m: {
  sharpness: number;
  artifact: number;
  bytesPerPixel: number;
  origVsDerived: number;
}): number {
  const sharpNorm = clamp01(Math.log1p(m.sharpness) / Math.log1p(SHARP_REF));
  const bppNorm = clamp01(m.bytesPerPixel / BPP_REF);
  const artifactNorm = clamp01(m.artifact); // already a "badness" ≥ 0
  const score =
    W_SHARP * sharpNorm +
    W_BPP * bppNorm +
    W_ARTIFACT * (1 - artifactNorm) +
    W_ORIG * clamp01(m.origVsDerived);
  return clamp01(score);
}

/** Assemble the full metrics (incl. composite score) for one asset. Pure. */
export function buildQualityMetrics(inp: QualityInputs): QualityMetrics {
  const px = (inp.origWidth ?? 0) * (inp.origHeight ?? 0);
  const bytesPerPixel = px > 0 ? inp.sizeBytes / px : 0;
  const megapixels = px / 1_000_000;
  const origVsDerived = inp.isOriginal ? 1 : 0.5;
  const score = compositeQualityScore({
    sharpness: inp.sharpness,
    artifact: inp.artifact,
    bytesPerPixel,
    origVsDerived,
  });
  return {
    sharpness: inp.sharpness,
    artifact: inp.artifact,
    bytesPerPixel,
    megapixels,
    origVsDerived,
    score,
  };
}

export interface ScoredAsset {
  assetId: string;
  metrics: QualityMetrics;
}

/**
 * Pick the canonical: highest composite score. Resolution (megapixels) is the
 * ONLY tiebreak when scores are within `eps`; a stable assetId sort is the final
 * tiebreak so the choice is deterministic + reproducible (ADR-0004). Returns the
 * canonical assetId, or null for an empty list.
 */
export function pickCanonical(scored: ScoredAsset[], eps = 0.02): string | null {
  if (scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => {
    const ds = b.metrics.score - a.metrics.score;
    if (Math.abs(ds) > eps) return ds > 0 ? 1 : -1;
    const dm = b.metrics.megapixels - a.metrics.megapixels;
    if (Math.abs(dm) > 1e-6) return dm > 0 ? 1 : -1;
    return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
  });
  return sorted[0].assetId;
}

export interface PreviewAnalysis {
  sharpness: number;
  artifact: number;
  width: number;
  height: number;
}

/**
 * Decode a preview derivative (already a web-safe WebP) to greyscale raw pixels
 * and compute the visual quality metrics. The only I/O-shaped fn here. Caller
 * supplies original size/dims/isOriginal for the bpp + tiebreak.
 */
export async function analyzePreview(previewBuffer: Buffer): Promise<PreviewAnalysis> {
  const { data, info } = await sharp(previewBuffer, { failOn: "none" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (width < 3 || height < 3) return { sharpness: 0, artifact: 0, width, height };
  const arr = singleChannel(data, info.channels);
  return {
    sharpness: laplacianVariance(arr, width, height),
    artifact: blockiness(arr, width, height),
    width,
    height,
  };
}

/** Extract the luminance plane from a raw buffer that may carry N channels.
 *  `.grayscale()` makes all channels equal, so channel 0 is the grey value. */
export function singleChannel(data: Buffer | Uint8Array, channels: number): Uint8Array {
  if (channels <= 1) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const n = Math.floor(data.length / channels);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = data[i * channels];
  return out;
}
