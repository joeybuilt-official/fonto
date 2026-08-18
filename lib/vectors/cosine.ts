// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cosine similarity between two equal-length vectors, in [-1, 1].
 *
 * Returns 0 if either vector is all-zero (cosine is undefined there). Throws
 * on length mismatch — both callers (Phase 4.2 search ranking and Phase 4.5
 * dedup) pass vectors produced by the same encoder, so a mismatch is always
 * a bug.
 *
 * Note: pgvector's `<=>` operator returns cosine *distance* (`1 - cosine
 * similarity`). The `nearestNeighbors` helper inverts that on the way out so
 * callers see a similarity score. This pure-JS implementation is for
 * in-memory work — re-ranking, unit tests, sanity checks against the
 * database result.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: length mismatch (${a.length} vs ${b.length})`
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
