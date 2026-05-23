// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ============================================================================
// RETIRED — Phase 4.3 (ADR 0002): pgvector replaces the FalkorDB mirror.
// ============================================================================
//
// This module used to mirror every uploaded asset's pHash into a FalkorDB
// sidecar so we could run vector kNN against it. ADR 0002 retires that path:
// vector data now lives in `postgres` via the `pgvector` extension, and
// near-duplicate detection goes through the in-DB pHash scan
// (`findPHashNearDuplicate` in `lib/assets/createAssetRow.ts`) plus the
// CLIP-embedding cosine search added in Phase 4.2 (`lib/vectors/`).
//
// The file is kept as a stub — not deleted — so any caller that hasn't been
// updated yet (notably `lib/assets/createAssetRow.ts`, and any future code
// land that pre-dates the cleanup) still type-checks and falls through to
// the no-op path. A follow-up PR will remove the dead call sites.
//
// FalkorDB env vars (`PLEXO_GRAPHITI_SIDECAR_URL`, `PLEXO_SERVICE_KEY`) are
// no longer read by this module. They remain meaningful for the unrelated
// Plexo Core memory facade and are not touched here.

/**
 * @deprecated Phase 4.3 / ADR 0002 — kept for binary-shape compatibility.
 *             pHash is a 64-bit bigint scan against `fonto.assets.phash`;
 *             CLIP embeddings live on `fonto.assets.clip_vec`. There is no
 *             external vector dimension to surface anymore.
 */
export const PHASH_VEC_DIMENSION = 64;

/**
 * @deprecated Phase 4.3 / ADR 0002. Returns a binary unpacking of the
 *             pHash that the old FalkorDB writer used. No current caller
 *             needs this — kept exported because external tests may import
 *             the symbol. Will be removed in a follow-up.
 */
export function phashToVec64(phash: bigint): number[] {
  const vec = new Array<number>(PHASH_VEC_DIMENSION);
  for (let i = 0; i < PHASH_VEC_DIMENSION; i++) {
    vec[i] = Number((phash >> BigInt(i)) & 1n);
  }
  return vec;
}

export interface MirrorAssetArgs {
  workspaceId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  lifecycleState: "active" | "archivable" | "archived" | "trashed";
  phash: bigint;
}

/**
 * @deprecated Phase 4.3 / ADR 0002 — no-op stub. The FalkorDB sidecar is
 *             retired; perceptual data is stored on `fonto.assets` and
 *             indexed via pgvector (`lib/vectors/`).
 */
export async function mirrorAssetToGraph(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args: MirrorAssetArgs
): Promise<{ ok: boolean }> {
  if (process.env.NODE_ENV !== "test") {
    console.info(
      "[fonto-graph] retired — using pgvector (see ADR 0002). mirrorAssetToGraph is now a no-op."
    );
  }
  return { ok: true };
}

export interface GraphPhashMatch {
  assetId: string;
  filename: string;
  /** Legacy field; always 0 on the stub return path. */
  score: number;
}

/**
 * @deprecated Phase 4.3 / ADR 0002 — always returns null. Callers fall back
 *             to the in-DB pHash scan (`findPHashNearDuplicate`) and, for
 *             CLIP-based similarity, to `lib/vectors/nearestNeighbors`.
 */
export async function findNearestAssetByPhashGraph(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args: {
    workspaceId: string;
    phash: bigint;
    excludeAssetId?: string;
    scoreThreshold: number;
  }
): Promise<GraphPhashMatch | null> {
  return null;
}

/**
 * @deprecated Phase 4.3 / ADR 0002 — always returns false now that the
 *             FalkorDB mirror is retired. Branches gated on this collapse
 *             to dead code; a follow-up PR will delete the call sites.
 */
export function fontoGraphConfigured(): boolean {
  return false;
}
