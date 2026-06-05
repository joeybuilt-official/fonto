// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.3 (ADR 0002) — nearest-neighbour search over `fonto.assets.clip_vec`.
//
// Hits the HNSW index created in migration 0017. Filters to the requested
// workspace and to rows that actually have an embedding (NULL clip_vec is
// excluded by the partial index, but we mirror the predicate in the WHERE
// clause so the planner can prove the index applies even on workspaces
// where the table is sparse).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export interface NearestNeighborMatch {
  assetId: string;
  /** Cosine similarity in [-1, 1]. Higher is more similar. */
  similarity: number;
}

interface NearestNeighborRow {
  id: string;
  similarity: number | string;
}

/**
 * Coerce a pgvector value into a `number[]`. Accepts either an already-parsed
 * array (the API search path passes a fresh CLIP embedding) or the raw string
 * literal "[0.1,0.2,...]" that postgres-js returns for a `vector` column read
 * via `db.execute` (the worker's clip-dedup-check path). Returns `[]` for
 * null/empty/malformed input so callers short-circuit safely.
 */
function normalizeVector(input: number[] | string | null | undefined): number[] {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string") return [];
  const trimmed = input.trim().replace(/^\[|\]$/g, "");
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/**
 * Cosine-distance kNN against `fonto.assets.clip_vec`, scoped to a single
 * workspace. Returns matches ordered by ascending distance (= descending
 * similarity).
 *
 * @param workspaceId scope; UUID of the workspace
 * @param queryVec   512-dim CLIP embedding to compare against
 * @param limit      max rows to return (HNSW `ef_search` defaults apply)
 * @param threshold  optional minimum cosine similarity in [-1, 1]; matches
 *                   below this are dropped. Use `0.2`-ish for "loosely
 *                   related" text-to-image queries, `0.9`+ for dedup.
 */
export async function nearestNeighbors(
  workspaceId: string,
  // pgvector columns selected via raw `db.execute` come back as a string
  // literal (e.g. "[0.1,0.2,...]"), NOT a number[]. The worker's
  // clip-dedup-check passes `row.clip_vec` straight through, so accept both
  // shapes and normalise — otherwise `.join` throws
  // "queryVec.join is not a function" and the dedup job crash-loops.
  queryVec: number[] | string,
  limit: number,
  threshold?: number
): Promise<NearestNeighborMatch[]> {
  const vec = normalizeVector(queryVec);
  if (vec.length === 0) return [];
  const literal = `[${vec.join(",")}]`;
  // Drizzle has no first-class pgvector operator binding, so we drop to raw
  // SQL. Parameters are still safely bound by postgres-js.
  const rows = (await db.execute(sql`
    SELECT
      id,
      1 - (clip_vec <=> ${literal}::vector) AS similarity
    FROM fonto.assets
    WHERE workspace_id = ${workspaceId}
      AND clip_vec IS NOT NULL
    ORDER BY clip_vec <=> ${literal}::vector
    LIMIT ${limit}
  `)) as unknown as NearestNeighborRow[];

  const matches: NearestNeighborMatch[] = rows.map((row) => ({
    assetId: row.id,
    similarity:
      typeof row.similarity === "string"
        ? Number(row.similarity)
        : row.similarity,
  }));

  if (threshold === undefined) return matches;
  return matches.filter((m) => m.similarity >= threshold);
}
