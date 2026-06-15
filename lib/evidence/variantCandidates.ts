// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Seed `fonto.variant_groups` candidate clusters
// from the SAME signals the upload-time dedup ladder already uses: pHash Hamming
// proximity + CLIP cosine proximity (ADR-0004 Stage-1). Phase 3 ONLY proposes
// candidates (status='candidate'); the destructive Stage-2 structural verify,
// canonical pick, and purge are Phase 5 and operator-gated.
//
// Idempotent: candidate groups are disposable. Each run resets the workspace's
// candidate groups (nulls their members' variant_group_id + deletes the rows)
// and recomputes from scratch. Groups already promoted to 'confirmed' /
// 'consolidated' (and their member assets) are PRESERVED untouched.
//
// The pHash pass is O(N²) in-memory popcounts (cheap); the CLIP pass is N HNSW
// neighbour queries. Both are fine for an occasional, env-gated backfill sweep;
// Phase 5 calibrates the thresholds per-corpus (the hardcoded 5 / 0.92 here just
// mirror the existing ladder defaults).

import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hammingDistance, phashFromDb } from "@/lib/perceptual";
import { nearestNeighbors } from "@/lib/vectors";
import { logger } from "@/lib/logger";
import { UnionFind } from "./unionFind";

// Mirror the upload-ladder defaults (createAssetRow.ts). Operator-overridable;
// Phase 5 replaces these with calibrated, per-corpus config.
function phashThreshold(): number {
  const raw = process.env.VARIANT_PHASH_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}
function clipThreshold(): number {
  const raw = process.env.VARIANT_CLIP_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.92;
}
const CLIP_NEIGHBOURS = 8;

export interface VariantCandidateResult {
  workspaceId: string;
  eligibleAssets: number;
  groupsCreated: number;
  assetsGrouped: number;
}

interface EligibleAsset {
  id: string;
  phash: bigint | null;
  clipVec: number[] | string | null;
}

/**
 * Recompute candidate variant groups for one workspace. Returns counts. Safe to
 * re-run (idempotent). Never touches confirmed/consolidated groups.
 */
export async function populateVariantCandidatesForWorkspace(
  workspaceId: string
): Promise<VariantCandidateResult> {
  const log = logger.child({ component: "evidence.variants", workspaceId });

  // 1. Preserve groups already promoted past 'candidate'.
  const preserved = await db
    .select({ id: schema.variantGroups.id })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspaceId),
        inArray(schema.variantGroups.status, ["confirmed", "consolidated"])
      )
    );
  const preservedIds = new Set(preserved.map((g) => g.id));

  // 2. Load active image assets that carry at least one perceptual signal.
  const rows = await db
    .select({
      id: schema.assets.id,
      mimeType: schema.assets.mimeType,
      phash: schema.assets.phash,
      clipVec: schema.assets.clipVec,
      variantGroupId: schema.assets.variantGroupId,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active")
      )
    );

  const eligible: EligibleAsset[] = rows
    .filter((r) => r.mimeType.startsWith("image/"))
    .filter((r) => r.phash != null || r.clipVec != null)
    // Exclude assets locked into a preserved group.
    .filter((r) => !(r.variantGroupId && preservedIds.has(r.variantGroupId)))
    .map((r) => ({
      id: r.id,
      phash: r.phash != null ? phashFromDb(BigInt(r.phash)) : null,
      clipVec: r.clipVec as number[] | string | null,
    }));

  if (eligible.length < 2) {
    await resetCandidateGroups(workspaceId, preservedIds);
    return { workspaceId, eligibleAssets: eligible.length, groupsCreated: 0, assetsGrouped: 0 };
  }

  // 3. Build the similarity edge list.
  const edges: Array<{ a: string; b: string; w: number }> = [];

  // 3a. pHash pairwise (O(N²) popcounts).
  const TH = phashThreshold();
  const withPhash = eligible.filter((a) => a.phash != null);
  for (let i = 0; i < withPhash.length; i++) {
    const ai = withPhash[i];
    for (let j = i + 1; j < withPhash.length; j++) {
      const aj = withPhash[j];
      const d = hammingDistance(ai.phash as bigint, aj.phash as bigint);
      if (d <= TH) edges.push({ a: ai.id, b: aj.id, w: 1 - d / 64 });
    }
  }

  // 3b. CLIP neighbours (HNSW). Only union neighbours that are themselves
  // eligible (a confirmed-group member returned by kNN is ignored).
  const eligibleIds = new Set(eligible.map((a) => a.id));
  const clipTH = clipThreshold();
  for (const a of eligible) {
    if (a.clipVec == null) continue;
    let matches: Awaited<ReturnType<typeof nearestNeighbors>>;
    try {
      matches = await nearestNeighbors(workspaceId, a.clipVec, CLIP_NEIGHBOURS, clipTH);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), assetId: a.id }, "clip kNN failed");
      continue;
    }
    for (const m of matches) {
      if (m.assetId === a.id) continue;
      if (!eligibleIds.has(m.assetId)) continue;
      edges.push({ a: a.id, b: m.assetId, w: m.similarity });
    }
  }

  // 4. Union-find → components, with a per-component max-edge confidence.
  const uf = new UnionFind(eligibleIds);
  for (const e of edges) uf.union(e.a, e.b);
  const comps = uf.components(2);

  const rootConfidence = new Map<string, number>();
  for (const e of edges) {
    const r = uf.find(e.a);
    rootConfidence.set(r, Math.max(rootConfidence.get(r) ?? 0, e.w));
  }

  // 5. Reset prior candidate groups, then materialise the fresh ones.
  await resetCandidateGroups(workspaceId, preservedIds);

  let groupsCreated = 0;
  let assetsGrouped = 0;
  for (const members of comps) {
    const sorted = [...members].sort();
    const root = uf.find(sorted[0]);
    const confidence = rootConfidence.get(root) ?? null;
    const [grp] = await db
      .insert(schema.variantGroups)
      .values({
        workspaceId,
        perceptualKey: sorted[0],
        groupingConfidence: confidence,
        status: "candidate",
      })
      .returning({ id: schema.variantGroups.id });
    await db
      .update(schema.assets)
      .set({ variantGroupId: grp.id })
      .where(
        and(
          eq(schema.assets.workspaceId, workspaceId),
          inArray(schema.assets.id, sorted)
        )
      );
    groupsCreated++;
    assetsGrouped += sorted.length;
  }

  log.info({ eligible: eligible.length, groupsCreated, assetsGrouped }, "variant candidates recomputed");
  return { workspaceId, eligibleAssets: eligible.length, groupsCreated, assetsGrouped };
}

/** Null candidate-group memberships + delete the candidate group rows. */
async function resetCandidateGroups(
  workspaceId: string,
  preservedIds: Set<string>
): Promise<void> {
  const candidates = await db
    .select({ id: schema.variantGroups.id })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspaceId),
        eq(schema.variantGroups.status, "candidate")
      )
    );
  const candIds = candidates.map((g) => g.id).filter((id) => !preservedIds.has(id));
  if (candIds.length === 0) return;
  await db
    .update(schema.assets)
    .set({ variantGroupId: null })
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        inArray(schema.assets.variantGroupId, candIds)
      )
    );
  await db.delete(schema.variantGroups).where(inArray(schema.variantGroups.id, candIds));
}
