// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Backfill sweeps that drive evidence extraction
// + variant-candidate population over existing libraries. Both are idempotent,
// resumable, and bounded per tick so a large library drains gradually without
// starving the asset pipeline. Default-OFF (env-gated) like the face-crop
// backfill — they exist so a sample workspace can be populated on demand and so
// the continuous re-audit (Phase 7) has a drift-sweep to build on.

import { and, eq, notExists, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { extractEvidenceQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";
import { populateVariantCandidatesForWorkspace } from "./variantCandidates";

/**
 * Enqueue an `extract-evidence` job for up to `batchSize` active image assets
 * that have NO evidence rows yet. Resumable: once an asset is extracted it gets
 * at least the fs_mtime row, so it drops out of this NOT-EXISTS probe on the
 * next tick. Returns how many were enqueued.
 */
export async function backfillEvidence(batchSize: number): Promise<{ enqueued: number }> {
  const log = logger.child({ component: "evidence.backfill" });

  const candidates = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        sql`${schema.assets.mimeType} LIKE 'image/%'`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(schema.imageDateEvidence)
            .where(eq(schema.imageDateEvidence.assetId, schema.assets.id))
        )
      )
    )
    .limit(batchSize);

  for (const c of candidates) {
    await extractEvidenceQueue().add(JobNames.ExtractEvidence, {
      assetId: c.id,
      workspaceId: c.workspaceId,
    });
  }
  log.info({ enqueued: candidates.length, batchSize }, "evidence backfill tick");
  return { enqueued: candidates.length };
}

/**
 * Recompute variant candidates for every workspace that has active image
 * assets. Each workspace is independently idempotent (see
 * populateVariantCandidatesForWorkspace). Returns per-workspace counts.
 */
export async function backfillVariantCandidates(): Promise<{
  workspaces: number;
  groupsCreated: number;
}> {
  const log = logger.child({ component: "evidence.variants.backfill" });

  const workspaces = await db
    .selectDistinct({ workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        sql`${schema.assets.mimeType} LIKE 'image/%'`
      )
    );

  let groupsCreated = 0;
  for (const w of workspaces) {
    const r = await populateVariantCandidatesForWorkspace(w.workspaceId);
    groupsCreated += r.groupsCreated;
  }
  log.info({ workspaces: workspaces.length, groupsCreated }, "variant-candidate backfill tick");
  return { workspaces: workspaces.length, groupsCreated };
}
