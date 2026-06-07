// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-time rebuild of Explore > Things on the curated CLIP taxonomy.
//
// The old Things surface was flooded with raw vision-labeller noise
// ("Repetition", "Forehead", "Pattern"). After wiping those aiSuggested tags
// we re-derive clean, category-level tags (Portraits, Landscape, Pets, …)
// straight from each asset's STORED clip_vec via the taxonomy cosine — no
// vision/LLM round-trip, so it is cheap and won't strain the worker.
//
// Resumable + idempotent: processes assets with auto_tagged_at IS NULL and
// stamps it, so the wipe step resets auto_tagged_at = NULL to enqueue work.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { classifyAsset } from "@/lib/classify/classify";
import { isJunkLabel } from "@/lib/processing/labelStoplist";

// CLIP-only: an empty fallback means uncertain assets simply get no Thing
// tag (they drop out of Things) rather than paying for an LLM call.
const NO_LLM = { classify: async () => ({ topLevel: "other", suggestedTags: [] as string[] }) };

export interface CuratedTagBackfillResult {
  scanned: number;
  tagged: number;
  more: boolean;
}

async function ensureTagId(workspaceId: string, name: string): Promise<string> {
  const existing = await db
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(and(eq(schema.tags.workspaceId, workspaceId), eq(schema.tags.name, name)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await db
    .insert(schema.tags)
    .values({ workspaceId, name, aiSuggested: true })
    .returning({ id: schema.tags.id });
  return created.id;
}

export async function backfillCuratedTags(batchSize: number): Promise<CuratedTagBackfillResult> {
  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      clipVec: schema.assets.clipVec,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.lifecycleState, "active"),
        isNotNull(schema.assets.clipVec),
        isNull(schema.assets.autoTaggedAt)
      )
    )
    .limit(batchSize);

  let tagged = 0;
  for (const row of rows) {
    try {
      const result = await classifyAsset(row.clipVec as number[] | null, NO_LLM);
      const names = Array.from(
        new Set(
          (result.suggestedTags ?? [])
            .map((n) => n.trim())
            .filter((n) => n.length > 0 && !isJunkLabel(n))
        )
      );
      for (const name of names) {
        const tagId = await ensureTagId(row.workspaceId, name);
        const link = await db
          .select({ assetId: schema.assetTags.assetId })
          .from(schema.assetTags)
          .where(and(eq(schema.assetTags.assetId, row.id), eq(schema.assetTags.tagId, tagId)))
          .limit(1);
        if (!link[0]) {
          await db.insert(schema.assetTags).values({ assetId: row.id, tagId });
          tagged++;
        }
      }
    } catch {
      // skip this asset; still stamp below so we don't loop on it forever
    }
    await db
      .update(schema.assets)
      .set({ autoTaggedAt: new Date() })
      .where(eq(schema.assets.id, row.id));
  }

  return { scanned: rows.length, tagged, more: rows.length === batchSize };
}
