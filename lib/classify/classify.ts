// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.6 — zero-shot CLIP classifier.
//
// Given an image's CLIP embedding, pick the best top-level taxonomy entry
// (argmax cosine) and — if the chosen top-level is above the confidence
// threshold AND has sub-categories — pick the best sub-level entry too.
//
// If confidence is too low (absolute or runner-up delta), defer to the
// existing LLM-based classifier. Per ADR 0001 this is the one case where
// the LLM is genuinely better than embeddings.

import { TAXONOMY, type SubCategory, legacyClassificationFor } from "./taxonomy";
import { loadTaxonomyVectors } from "./vectors";
import { zeroShotConfidenceBuckets } from "@/lib/metrics";

export interface ClassifyResult {
  /** Legacy `classification` string (compatible with existing code). */
  topLevel: string;
  /** Taxonomy `top.key`. May differ from `topLevel` for `legacyClassificationFor` collapses. */
  taxonomyTopKey: string;
  /** `subs[i].key` or null if the top-level has no subs / confidence too low. */
  subLevel: string | null;
  /** Top-1 cosine similarity in [0, 1]. */
  confidence: number;
  /** Tag suggestion strings to send through the ai-suggested-tag path. */
  suggestedTags: string[];
  /** Path that produced the answer — for metrics + future re-classification. */
  method: "clip" | "llm-fallback";
}

/** Default 0.18 — CLIP cosine for image+text rarely exceeds 0.3. */
const DEFAULT_THRESHOLD = 0.18;
/** Minimum delta between top-1 and top-2 to call the choice "decisive". */
const DEFAULT_RUNNER_UP_DELTA = 0.05;

function threshold(): number {
  const raw = process.env.CLASSIFY_CONFIDENCE_THRESHOLD;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
}

function runnerUpDelta(): number {
  const raw = process.env.CLASSIFY_RUNNER_UP_DELTA;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_RUNNER_UP_DELTA;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  // TODO(4.3): replace with `cosineSimilarity` from `lib/vectors/`.
  // Inlined here so this file works even if 4.3 hasn't landed yet.
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  const denom = Math.sqrt(aa) * Math.sqrt(bb);
  return denom === 0 ? 0 : dot / denom;
}

interface LlmFallback {
  classify: () => Promise<{
    topLevel: string;
    suggestedTags?: string[];
  }>;
}

/**
 * Classify an asset from its CLIP embedding. If CLIP confidence is low
 * (or vectors aren't available), defer to the supplied `llmFallback`
 * callback. The callback wraps the existing `plexoClassifyAsset` call
 * so this module stays free of Plexo-SDK plumbing.
 */
export async function classifyAsset(
  clipVec: number[] | null | undefined,
  llmFallback: LlmFallback,
): Promise<ClassifyResult> {
  const t = threshold();

  if (!clipVec || clipVec.length === 0) {
    return runFallback(llmFallback, 0);
  }

  const cache = await loadTaxonomyVectors();
  if (!cache) {
    return runFallback(llmFallback, 0);
  }

  // Score every top-level.
  const topScores: { topKey: string; score: number }[] = [];
  for (const top of TAXONOMY) {
    const entry = cache.vectors.find((v) => v.id === `top:${top.key}`);
    if (!entry) continue;
    topScores.push({ topKey: top.key, score: cosine(clipVec, entry.vec) });
  }
  topScores.sort((a, b) => b.score - a.score);
  if (topScores.length === 0) {
    return runFallback(llmFallback, 0);
  }

  const winner = topScores[0];
  const runnerUp = topScores[1]?.score ?? 0;
  zeroShotConfidenceBuckets.observe(winner.score);

  if (winner.score < t || winner.score - runnerUp < runnerUpDelta()) {
    return runFallback(llmFallback, winner.score);
  }

  // Score sub-levels under the winning top-level.
  const top = TAXONOMY.find((c) => c.key === winner.topKey)!;
  let bestSub: SubCategory | null = null;
  let bestSubScore = 0;
  for (const sub of top.subs) {
    const entry = cache.vectors.find((v) => v.id === `sub:${top.key}:${sub.key}`);
    if (!entry) continue;
    const score = cosine(clipVec, entry.vec);
    if (score > bestSubScore) {
      bestSubScore = score;
      bestSub = sub;
    }
  }

  const subPicked = bestSub && bestSubScore >= t ? bestSub : null;

  return {
    topLevel: legacyClassificationFor(top.key),
    taxonomyTopKey: top.key,
    subLevel: subPicked?.key ?? null,
    confidence: winner.score,
    suggestedTags: subPicked?.tags ?? [],
    method: "clip",
  };
}

/**
 * Relaxed taxonomy tagging for Explore > Things. classifyAsset() defers to the
 * LLM whenever CLIP confidence is below the strict primary-classification
 * threshold — which is ~always for real-world libraries (zero-shot cosine sits
 * around 0.2–0.3). For a discovery surface that's too conservative: here we
 * just take the closest curated sub-category tags by cosine, free of any LLM
 * round-trip. Returns up to `maxTags` distinct names, or [] if nothing clears
 * the floor.
 */
export async function relaxedTaxonomyTags(
  clipVec: number[] | null | undefined,
  opts: { floor?: number; maxTags?: number } = {},
): Promise<string[]> {
  const floor = opts.floor ?? 0.2;
  const maxTags = opts.maxTags ?? 2;
  if (!clipVec || clipVec.length === 0) return [];
  const cache = await loadTaxonomyVectors();
  if (!cache) return [];
  const scored: { score: number; tags: string[] }[] = [];
  for (const top of TAXONOMY) {
    for (const sub of top.subs) {
      const entry = cache.vectors.find((v) => v.id === `sub:${top.key}:${sub.key}`);
      if (!entry) continue;
      const score = cosine(clipVec, entry.vec);
      if (score >= floor && sub.tags.length > 0) scored.push({ score, tags: sub.tags });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    for (const t of s.tags) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= maxTags) return out;
    }
  }
  return out;
}

async function runFallback(llm: LlmFallback, observedConfidence: number): Promise<ClassifyResult> {
  if (observedConfidence > 0) {
    zeroShotConfidenceBuckets.observe(observedConfidence);
  }
  const result = await llm.classify();
  return {
    topLevel: result.topLevel,
    taxonomyTopKey: result.topLevel,
    subLevel: null,
    confidence: observedConfidence,
    suggestedTags: result.suggestedTags ?? [],
    method: "llm-fallback",
  };
}
