// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.3 (ADR 0002) — pgvector helpers.
//
// Re-exports the cosine-similarity utility and the nearest-neighbour scan
// against `fonto.assets.clip_vec`. Used by Phase 4.2 text-to-image search
// and Phase 4.5 dedup. Vector columns themselves live on the assets table
// (see `lib/db/schema.ts`); writes go through the standard Drizzle insert
// path (`drizzle-vector.ts` handles the wire format).

export { cosineSimilarity } from "./cosine";
export { nearestNeighbors, type NearestNeighborMatch } from "./nearest";
