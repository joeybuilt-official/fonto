// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5 (ADR-0004/0005). Variant consolidation: turn a
// pHash/CLIP CANDIDATE group into a reviewed decision. The flow is
// MANIFEST-FIRST + reversible:
//
//   1. buildGroupManifest  — dry-run, NO writes. Downloads each member's preview,
//      scores quality, picks the canonical, Stage-2 SSIM-verifies every other
//      member against it, and routes via the destructive gate.
//   2. commitConsolidation — REVERSIBLE. Marks the group confirmed + canonical,
//      and flips confirmed-variant members to consolidation_state='trashed' with
//      a trash_purge_at grace window. Touches NONE of the user-delete lifecycle
//      (deletedAt/lifecycleState) and deletes NOTHING from R2/DB.
//
// The actual hard purge (irreversible) lives in purge.ts and is operator-gated.

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { storage } from "@/lib/storage";
import { assetDerivativeKey } from "@/lib/r2";
import { logger } from "@/lib/logger";
import {
  analyzePreview,
  buildQualityMetrics,
  pickCanonical,
  type QualityMetrics,
  type ScoredAsset,
} from "./quality";
import { structuralSimilarity, SSIM_VARIANT_GATE } from "./structuralVerify";
import { gateDecision, type GateDecision } from "@/lib/fusion/gate";

const DEFAULT_TRASH_GRACE_DAYS = 30;
// SSIM ≥ this within a confirmed group ⇒ eligible for the purge auto-bar (still
// operator-gated for the first real purge). Between the variant gate and this ⇒
// review lane.
const PURGE_SSIM_HIGH = 0.95;

export interface MemberManifest {
  assetId: string;
  score: number;
  ssimToCanonical: number | null;
  metrics: QualityMetrics;
}

export interface GroupManifest {
  groupId: string;
  workspaceId: string;
  canonicalAssetId: string;
  canonicalMetrics: QualityMetrics;
  /** Members confirmed as the same shot (SSIM ≥ gate) → consolidation targets. */
  trashCandidates: MemberManifest[];
  /** Members that grouped but FAILED Stage-2 (e.g. a crop) → kept, never trashed. */
  keptDistinct: MemberManifest[];
  /** Weakest confirmed SSIM — the destructive gate score. */
  confidence: number;
  decision: GateDecision;
  skippedNoPreview: string[];
}

interface MemberRow {
  id: string;
  workspaceId: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  derivedFromAssetId: string | null;
  previewKey: string | null;
}

async function loadPreview(m: MemberRow): Promise<Buffer | null> {
  const key = m.previewKey ?? assetDerivativeKey(m.workspaceId, m.id, "preview");
  try {
    return await storage().getBuffer(key);
  } catch {
    return null;
  }
}

/**
 * Build the dry-run manifest for one candidate group. NO writes. Returns null if
 * the group has fewer than 2 scoreable members.
 */
export async function buildGroupManifest(groupId: string): Promise<GroupManifest | null> {
  const log = logger.child({ component: "variants.manifest", groupId });

  const [group] = await db
    .select({ id: schema.variantGroups.id, workspaceId: schema.variantGroups.workspaceId })
    .from(schema.variantGroups)
    .where(eq(schema.variantGroups.id, groupId))
    .limit(1);
  if (!group) return null;

  const members = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      sizeBytes: schema.assets.sizeBytes,
      widthPx: schema.assets.widthPx,
      heightPx: schema.assets.heightPx,
      derivedFromAssetId: schema.assets.derivedFromAssetId,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.variantGroupId, groupId),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.assets.consolidationState, "none")
      )
    );
  if (members.length < 2) return null;

  // 1. Quality-score every member that has a decodable preview.
  const previews = new Map<string, Buffer>();
  const scored: ScoredAsset[] = [];
  const skippedNoPreview: string[] = [];
  for (const m of members) {
    const buf = await loadPreview(m);
    if (!buf) {
      skippedNoPreview.push(m.id);
      continue;
    }
    previews.set(m.id, buf);
    const a = await analyzePreview(buf);
    const metrics = buildQualityMetrics({
      sharpness: a.sharpness,
      artifact: a.artifact,
      sizeBytes: m.sizeBytes,
      origWidth: m.widthPx,
      origHeight: m.heightPx,
      isOriginal: m.derivedFromAssetId == null,
    });
    scored.push({ assetId: m.id, metrics });
  }
  if (scored.length < 2) return null;

  // 2. Canonical = best deterministic quality.
  const canonicalAssetId = pickCanonical(scored)!;
  const canonicalBuf = previews.get(canonicalAssetId)!;
  const metricsById = new Map(scored.map((s) => [s.assetId, s.metrics]));

  // 3. Stage-2 SSIM-verify every other member against the canonical.
  const trashCandidates: MemberManifest[] = [];
  const keptDistinct: MemberManifest[] = [];
  for (const s of scored) {
    if (s.assetId === canonicalAssetId) continue;
    const ssimVal = await structuralSimilarity(canonicalBuf, previews.get(s.assetId)!);
    const entry: MemberManifest = {
      assetId: s.assetId,
      score: s.metrics.score,
      ssimToCanonical: ssimVal,
      metrics: s.metrics,
    };
    if (ssimVal >= SSIM_VARIANT_GATE) trashCandidates.push(entry);
    else keptDistinct.push(entry);
  }

  // 4. Destructive gate: score = weakest confirmed SSIM.
  const confidence = trashCandidates.length
    ? Math.min(...trashCandidates.map((c) => c.ssimToCanonical ?? 0))
    : 0;
  const decision = gateDecision({
    score: confidence,
    action: "purge",
    structurallyVerified: trashCandidates.length > 0 && confidence >= SSIM_VARIANT_GATE,
    thresholds: {
      date: { high: 0.7, low: 0.35 },
      purge: { high: PURGE_SSIM_HIGH, low: SSIM_VARIANT_GATE },
    },
  });

  log.info(
    { canonical: canonicalAssetId, trash: trashCandidates.length, kept: keptDistinct.length, confidence, decision },
    "group manifest built"
  );
  return {
    groupId,
    workspaceId: group.workspaceId,
    canonicalAssetId,
    canonicalMetrics: metricsById.get(canonicalAssetId)!,
    trashCandidates,
    keptDistinct,
    confidence,
    decision,
    skippedNoPreview,
  };
}

/** Build manifests for candidate groups in a workspace (dry-run report). The
 *  optional `limit` bounds R2/SSIM cost for a sampled review. */
export async function buildWorkspaceManifests(
  workspaceId: string,
  limit?: number
): Promise<GroupManifest[]> {
  const q = db
    .select({ id: schema.variantGroups.id })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspaceId),
        eq(schema.variantGroups.status, "candidate")
      )
    );
  const groups = limit && limit > 0 ? await q.limit(limit) : await q;
  const out: GroupManifest[] = [];
  for (const g of groups) {
    const m = await buildGroupManifest(g.id);
    if (m) out.push(m);
  }
  return out;
}

export interface CommitResult {
  groupId: string;
  canonicalAssetId: string;
  trashed: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Reversibly apply a manifest: mark the group confirmed + canonical, stamp
 * quality_metrics, and flip confirmed-variant members to
 * consolidation_state='trashed' with a grace window. Writes NOTHING to R2 and
 * never touches the user-delete lifecycle. Undo = clear consolidation_state.
 *
 * `requireAutoCommit` (default true) refuses to act on a manifest the gate
 * routed to review/leave — the first real consolidation stays operator-driven.
 */
export async function commitConsolidation(
  groupId: string,
  opts: { graceDays?: number; requireAutoCommit?: boolean } = {}
): Promise<CommitResult> {
  const graceDays = opts.graceDays ?? DEFAULT_TRASH_GRACE_DAYS;
  const requireAutoCommit = opts.requireAutoCommit ?? true;

  const manifest = await buildGroupManifest(groupId);
  if (!manifest) return { groupId, canonicalAssetId: "", trashed: 0, skipped: true, reason: "no-manifest" };
  if (manifest.trashCandidates.length === 0)
    return { groupId, canonicalAssetId: manifest.canonicalAssetId, trashed: 0, skipped: true, reason: "no-confirmed-variants" };
  if (requireAutoCommit && manifest.decision !== "auto-commit")
    return { groupId, canonicalAssetId: manifest.canonicalAssetId, trashed: 0, skipped: true, reason: `gate=${manifest.decision}` };

  const purgeAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx
      .update(schema.variantGroups)
      .set({ status: "confirmed", canonicalAssetId: manifest.canonicalAssetId, updatedAt: new Date() })
      .where(eq(schema.variantGroups.id, groupId));
    await tx
      .update(schema.assets)
      .set({ isCanonical: true, qualityMetrics: manifest.canonicalMetrics })
      .where(eq(schema.assets.id, manifest.canonicalAssetId));
    for (const c of manifest.trashCandidates) {
      await tx
        .update(schema.assets)
        .set({
          consolidationState: "trashed",
          trashPurgeAt: purgeAt,
          qualityMetrics: c.metrics,
        })
        .where(
          and(
            eq(schema.assets.id, c.assetId),
            // Defence: only an active, not-already-trashed row.
            eq(schema.assets.lifecycleState, "active"),
            eq(schema.assets.consolidationState, "none")
          )
        );
    }
  });

  return {
    groupId,
    canonicalAssetId: manifest.canonicalAssetId,
    trashed: manifest.trashCandidates.length,
    skipped: false,
  };
}

/** Undo a consolidation: clear trashed state on a group's members + revert the
 *  group to candidate. Reversible safety net before purge. */
export async function undoConsolidation(groupId: string): Promise<{ restored: number }> {
  const restored = await db
    .update(schema.assets)
    .set({ consolidationState: "none", trashPurgeAt: null })
    .where(
      and(
        eq(schema.assets.variantGroupId, groupId),
        eq(schema.assets.consolidationState, "trashed")
      )
    )
    .returning({ id: schema.assets.id });
  await db
    .update(schema.variantGroups)
    .set({ status: "candidate", canonicalAssetId: null, updatedAt: new Date() })
    .where(eq(schema.variantGroups.id, groupId));
  await db
    .update(schema.assets)
    .set({ isCanonical: false })
    .where(and(eq(schema.assets.variantGroupId, groupId), eq(schema.assets.isCanonical, true)));
  return { restored: restored.length };
}
