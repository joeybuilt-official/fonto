// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5 TDD harness for the PURE variant primitives:
// Laplacian-variance sharpness, blockiness, composite quality score, canonical
// pick, and windowed SSIM. DB-free + sharp-free. Run: pnpm test:variants.

import assert from "node:assert/strict";
import {
  laplacianVariance,
  blockiness,
  compositeQualityScore,
  pickCanonical,
  type ScoredAsset,
  type QualityMetrics,
} from "../lib/variants/quality";
import { ssim } from "../lib/variants/structuralVerify";

let passed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

function fill(w: number, h: number, fn: (x: number, y: number) => number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y) & 0xff;
  return a;
}

// ── laplacianVariance ────────────────────────────────────────────────────────
t("laplacian: flat image is 0", () => {
  assert.equal(laplacianVariance(fill(16, 16, () => 128), 16, 16), 0);
});
t("laplacian: checkerboard >> flat (sharp edges)", () => {
  const checker = laplacianVariance(fill(16, 16, (x, y) => ((x + y) % 2 ? 255 : 0)), 16, 16);
  assert.ok(checker > 1000, `checker=${checker}`);
});

// ── blockiness ───────────────────────────────────────────────────────────────
t("blockiness: flat image is 0", () => {
  assert.equal(blockiness(fill(32, 32, () => 100), 32, 32), 0);
});
t("blockiness: 8px-grid steps register artefacts", () => {
  // Constant within each 8px column block, jump at x%8==0 → blocky.
  const b = blockiness(fill(32, 32, (x) => (Math.floor(x / 8) * 60) % 256), 32, 32);
  assert.ok(b > 0, `blockiness=${b}`);
});

// ── compositeQualityScore ────────────────────────────────────────────────────
t("quality: monotonic in sharpness", () => {
  const lo = compositeQualityScore({ sharpness: 50, artifact: 0, bytesPerPixel: 2, origVsDerived: 1 });
  const hi = compositeQualityScore({ sharpness: 1500, artifact: 0, bytesPerPixel: 2, origVsDerived: 1 });
  assert.ok(hi > lo, `hi=${hi} lo=${lo}`);
});
t("quality: original beats derived, all else equal", () => {
  const orig = compositeQualityScore({ sharpness: 800, artifact: 0.1, bytesPerPixel: 2, origVsDerived: 1 });
  const deriv = compositeQualityScore({ sharpness: 800, artifact: 0.1, bytesPerPixel: 2, origVsDerived: 0.5 });
  assert.ok(orig > deriv);
});
t("quality: artefacts lower the score", () => {
  const clean = compositeQualityScore({ sharpness: 800, artifact: 0, bytesPerPixel: 2, origVsDerived: 1 });
  const blocky = compositeQualityScore({ sharpness: 800, artifact: 1, bytesPerPixel: 2, origVsDerived: 1 });
  assert.ok(clean > blocky);
});

// ── pickCanonical ────────────────────────────────────────────────────────────
const mk = (assetId: string, score: number, megapixels: number): ScoredAsset => ({
  assetId,
  metrics: { sharpness: 0, artifact: 0, bytesPerPixel: 0, megapixels, origVsDerived: 1, score } as QualityMetrics,
});
t("canonical: highest score wins", () => {
  assert.equal(pickCanonical([mk("a", 0.5, 10), mk("b", 0.8, 5)]), "b");
});
t("canonical: near-tie breaks on resolution", () => {
  assert.equal(pickCanonical([mk("a", 0.5, 10), mk("b", 0.51, 5)]), "a");
});
t("canonical: full tie breaks on stable id", () => {
  assert.equal(pickCanonical([mk("z", 0.5, 8), mk("a", 0.5, 8)]), "a");
});

// ── ssim ─────────────────────────────────────────────────────────────────────
t("ssim: identical = 1", () => {
  const img = fill(16, 16, (x, y) => (x * 7 + y * 13) & 0xff);
  assert.equal(ssim(img, img, 16, 16), 1);
});
t("ssim: black vs white ~ 0", () => {
  const black = fill(16, 16, () => 0);
  const white = fill(16, 16, () => 255);
  assert.ok(ssim(black, white, 16, 16) < 0.05);
});
t("ssim: tiny perturbation stays high", () => {
  const a = fill(16, 16, (x, y) => (x * 7 + y * 13) & 0xff);
  const b = a.slice();
  b[0] = (b[0] + 5) & 0xff;
  assert.ok(ssim(a, b, 16, 16) > 0.95);
});

console.log(`\n✓ ${passed} variant assertions passed`);
