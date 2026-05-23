// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.2/4.3 — pgvector nearest-neighbour helpers.
//
// The full implementation (pgvector index + IVF/HNSW tuning) lands in 4.3
// alongside the `assets.clip_vec` column migration. This module is the
// boundary the 4.2 search route calls into, so 4.3 has a stable signature to
// land against.
//
// Until 4.3 ships, `nearestNeighbors()` attempts the query against the
// `clip_vec` column and gracefully degrades to an empty result if the column
// doesn't exist (Postgres 42703) — letting the API route stay live without
// 500s in environments where the migration hasn't run yet.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface NearestNeighborHit {
  assetId: string;
  similarity: number;
}

/** Format `number[]` as a pgvector literal `[0.1,0.2,...]`. */
function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Return up to `limit` assets in `workspaceId` whose `clip_vec` is most
 * similar to `queryVec` (cosine similarity ≥ `threshold`). Results are
 * sorted by similarity descending.
 *
 * Cosine similarity ∈ [-1, 1]; for CLIP latent vectors it's typically in
 * [0, 0.4] range, so the default threshold of 0.2 is a reasonable cutoff
 * that surfaces "loosely related" without flooding with noise.
 *
 * Returns `[]` if:
 *   - the input vector is empty
 *   - the `clip_vec` column hasn't been migrated yet (4.3 not landed)
 *   - the query fails for any other reason (logged and swallowed)
 */
export async function nearestNeighbors(
  workspaceId: string,
  queryVec: number[],
  limit: number,
  threshold = 0.2
): Promise<NearestNeighborHit[]> {
  if (!queryVec.length) return [];
  const literal = toPgVectorLiteral(queryVec);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  // pgvector's `<=>` operator returns cosine *distance* (1 - similarity).
  // We convert back to similarity in SQL so the API surface is cleaner.
  try {
    const rows = (await db.execute(
      sql`
        SELECT id::text AS asset_id,
               1 - (clip_vec <=> ${literal}::vector) AS similarity
        FROM fonto.assets
        WHERE workspace_id = ${workspaceId}::uuid
          AND lifecycle_state = 'active'
          AND clip_vec IS NOT NULL
          AND (1 - (clip_vec <=> ${literal}::vector)) >= ${threshold}
        ORDER BY clip_vec <=> ${literal}::vector ASC
        LIMIT ${safeLimit}
      `
    )) as unknown as { rows?: Array<{ asset_id: string; similarity: number | string }> } | Array<{
      asset_id: string;
      similarity: number | string;
    }>;
    // node-postgres returns { rows }; some drivers return the array directly.
    const list = Array.isArray(rows) ? rows : rows.rows ?? [];
    return list.map((r) => ({
      assetId: r.asset_id,
      similarity:
        typeof r.similarity === "number" ? r.similarity : Number(r.similarity),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/clip_vec|undefined column|42703|type "vector"|extension/i.test(msg)) {
      // TODO(4.3): drop this branch once the pgvector extension + column
      // migration ships. Until then this is the normal "feature not yet
      // wired" path.
      logger.warn(
        { workspaceId, err: msg },
        "nearestNeighbors: clip_vec column not available — phase 4.3 pending"
      );
      return [];
    }
    logger.error({ workspaceId, err: msg }, "nearestNeighbors query failed");
    return [];
  }
}
