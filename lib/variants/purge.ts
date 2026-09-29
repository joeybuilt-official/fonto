// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5 (ADR-0004). The IRREVERSIBLE step: hard-purge a
// consolidation-trashed variant once its grace window has elapsed. Multiple
// guards make a wrong purge impossible:
//
//   (a) the asset is consolidation_state='trashed', still lifecycle 'active'
//       (a user delete/archive takes precedence — we never touch those), and
//       past its trash_purge_at grace window;
//   (b) its group is 'confirmed' with a canonical that is itself INTACT
//       (active, not trashed) — a verified survivor exists;
//   (c) the canonical is STILL structurally equivalent (SSIM re-verified at
//       purge time, not trusted from the trash-time decision);
//   (d) the asset is no-one's `derived_from` source (purging it would orphan a
//       user crop/edit).
//
// Defaults to dryRun. There is NO scheduler wired to this — the first real purge
// is operator-driven (plan gate). When it does run, it uses the standard
// lifecycle='purged' terminal state so the removal propagates through delta-sync
// + the UI exactly like any other purge; consolidation_state='trashed' is kept
// for provenance.

import { and, eq, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { storage, localFs } from "@/lib/storage";
import {
  assetStorageKey,
  assetStorageKeyLegacy,
  assetDerivativeKey,
  hlsSegmentKeyPrefix,
} from "@/lib/r2";
import { logger } from "@/lib/logger";
import { structuralSimilarity, SSIM_VARIANT_GATE } from "./structuralVerify";

export interface PurgeEvaluation {
  eligible: boolean;
  reason: string;
  canonicalAssetId?: string;
  ssimToCanonical?: number;
}

async function preview(workspaceId: string, assetId: string, previewKey: string | null): Promise<Buffer | null> {
  const key = previewKey ?? assetDerivativeKey(workspaceId, assetId, "preview");
  try {
    return await storage().getBuffer(key);
  } catch {
    return null;
  }
}

/** Run every guard WITHOUT deleting anything. */
export async function evaluatePurge(assetId: string): Promise<PurgeEvaluation> {
  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      lifecycleState: schema.assets.lifecycleState,
      consolidationState: schema.assets.consolidationState,
      trashPurgeAt: schema.assets.trashPurgeAt,
      variantGroupId: schema.assets.variantGroupId,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);
  if (!asset) return { eligible: false, reason: "asset-missing" };

  // (a)
  if (asset.lifecycleState !== "active") return { eligible: false, reason: `lifecycle=${asset.lifecycleState}` };
  if (asset.consolidationState !== "trashed") return { eligible: false, reason: "not-consolidation-trashed" };
  if (!asset.trashPurgeAt || asset.trashPurgeAt.getTime() > Date.now())
    return { eligible: false, reason: "within-grace" };
  if (!asset.variantGroupId) return { eligible: false, reason: "no-group" };

  // (b) confirmed group with an intact canonical.
  const [group] = await db
    .select({ status: schema.variantGroups.status, canonicalAssetId: schema.variantGroups.canonicalAssetId })
    .from(schema.variantGroups)
    .where(eq(schema.variantGroups.id, asset.variantGroupId))
    .limit(1);
  if (!group || group.status !== "confirmed" || !group.canonicalAssetId)
    return { eligible: false, reason: "group-not-confirmed" };

  const [canonical] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      lifecycleState: schema.assets.lifecycleState,
      consolidationState: schema.assets.consolidationState,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, group.canonicalAssetId))
    .limit(1);
  if (!canonical || canonical.lifecycleState !== "active" || canonical.consolidationState !== "none")
    return { eligible: false, reason: "canonical-not-intact", canonicalAssetId: group.canonicalAssetId };

  // (d) never orphan a user derivative.
  const [child] = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(eq(schema.assets.derivedFromAssetId, assetId), ne(schema.assets.lifecycleState, "purged")))
    .limit(1);
  if (child) return { eligible: false, reason: "has-derivatives", canonicalAssetId: canonical.id };

  // (c) structural equivalence re-verified at purge time.
  const [bufV, bufC] = await Promise.all([
    preview(asset.workspaceId, asset.id, asset.previewKey),
    preview(canonical.workspaceId, canonical.id, canonical.previewKey),
  ]);
  if (!bufV || !bufC) return { eligible: false, reason: "preview-unavailable", canonicalAssetId: canonical.id };
  const ssim = await structuralSimilarity(bufC, bufV);
  if (ssim < SSIM_VARIANT_GATE)
    return { eligible: false, reason: "structural-reverify-failed", canonicalAssetId: canonical.id, ssimToCanonical: ssim };

  return { eligible: true, reason: "ok", canonicalAssetId: canonical.id, ssimToCanonical: ssim };
}

export interface PurgeResult {
  assetId: string;
  purged: boolean;
  dryRun: boolean;
  reason: string;
}

/**
 * Purge ONE consolidation-trashed variant. Defaults to dryRun (evaluates the
 * guards + reports, deletes nothing). Set dryRun:false to actually delete R2
 * objects + flip lifecycle to 'purged'. OPERATOR-GATED: nothing schedules this.
 */
export async function purgeConsolidatedVariant(
  assetId: string,
  opts: { dryRun?: boolean } = {}
): Promise<PurgeResult> {
  const dryRun = opts.dryRun ?? true;
  const log = logger.child({ component: "variants.purge", assetId, dryRun });

  const evalResult = await evaluatePurge(assetId);
  if (!evalResult.eligible) return { assetId, purged: false, dryRun, reason: evalResult.reason };
  if (dryRun) {
    log.info({ canonical: evalResult.canonicalAssetId, ssim: evalResult.ssimToCanonical }, "purge eligible (dry-run)");
    return { assetId, purged: false, dryRun, reason: "eligible-dry-run" };
  }

  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId, filename: schema.assets.filename, localOriginalStoredAt: schema.assets.localOriginalStoredAt })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);
  if (!asset) return { assetId, purged: false, dryRun, reason: "asset-missing" };

  const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);
  try {
    await storage().delete(key);
  } catch {
    await storage().delete(legacyKey).catch(() => undefined);
  }
  // Derivatives + HLS ladder (best-effort).
  await storage().delete(assetDerivativeKey(asset.workspaceId, asset.id, "preview")).catch(() => undefined);
  await storage().delete(assetDerivativeKey(asset.workspaceId, asset.id, "thumb")).catch(() => undefined);
  await storage().deletePrefix(hlsSegmentKeyPrefix(asset.workspaceId, asset.id)).catch(() => undefined);
  if (process.env.LOCAL_STORAGE_ROOT && asset.localOriginalStoredAt) {
    await localFs().delete(key).catch(() => undefined);
    await localFs().delete(legacyKey).catch(() => undefined);
  }

  // Standard terminal state so the removal propagates via delta-sync + UI;
  // consolidation_state='trashed' stays for provenance.
  await db
    .update(schema.assets)
    .set({ lifecycleState: "purged", purgedAt: new Date() })
    .where(eq(schema.assets.id, assetId));

  log.info({ canonical: evalResult.canonicalAssetId }, "variant purged");
  return { assetId, purged: true, dryRun, reason: "purged" };
}

/**
 * Convenience: list every variant currently past its grace window + eligible to
 * purge (dry-run evaluation across the workspace). Never deletes. The operator
 * reviews this before authorising any real purge.
 */
export async function listPurgeable(workspaceId: string): Promise<PurgeEvaluation[]> {
  const trashed = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.consolidationState, "trashed"),
        eq(schema.assets.lifecycleState, "active"),
        isNull(schema.assets.purgedAt)
      )
    );
  const out: PurgeEvaluation[] = [];
  for (const t of trashed) out.push(await evaluatePurge(t.id));
  return out;
}
