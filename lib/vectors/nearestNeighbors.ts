// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.3 placeholder: workspace-scoped k-NN search over `assets.clip_vec`.
//
// The real implementation will issue a pgvector `<=>` cosine-distance query
// against an HNSW or IVFFlat index, filtered to the calling workspace and the
// `active` lifecycle. Until 4.3 ships the index + Drizzle column, this stub
// returns `[]` so every consumer (createAssetRow, the scan script, the worker)
// gracefully degrades to "no matches".
//
// TODO(phase-4.3): replace stub with real pgvector query.

export interface NearestNeighborMatch {
  /** Matching asset's UUID. */
  assetId: string;
  /** Cosine similarity in `[0, 1]` (higher = more similar). */
  similarity: number;
}

export interface NearestNeighborOptions {
  /** Maximum matches to return. */
  limit?: number;
  /** Minimum similarity threshold; matches below this are dropped. */
  threshold?: number;
  /** Optional asset id to exclude from the result set (e.g. the query asset). */
  excludeAssetId?: string;
}

/**
 * Return the nearest `limit` assets in `workspaceId` whose `clip_vec` cosine
 * similarity to `queryVec` is at least `threshold`. Results are sorted by
 * similarity descending.
 *
 * Phase 4.5 calls this AFTER pHash dedup so the threshold default is tight
 * (0.92) — we only want second-pass "visually similar" hits the pHash check
 * missed.
 */
export async function nearestNeighbors(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _queryVec: number[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts?: NearestNeighborOptions
): Promise<NearestNeighborMatch[]> {
  // Phase 4.3 stub — no vector index wired yet.
  return [];
}
