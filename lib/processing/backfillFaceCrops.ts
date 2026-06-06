// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (faces/UX) — throttled backfill of face-crop derivatives for
// EXISTING faces (those detected before the detect-time crop landed).
//
// Runs on the maintenance queue in SMALL batches (default 25 faces per tick),
// reusing the per-asset shared decode in `generateFaceCropsForAsset`. Idempotent
// + resumable: it only ever selects `face_crop_key IS NULL`, so a crash or a
// partial batch just gets re-picked next tick; a face that already has a key is
// never re-cropped. See ADR 0001 (D1, pre-mortem #1 — gentle on the worker we
// just stabilised).
//
// DEFAULT-OFF: the recurring schedule is only registered when
// BACKFILL_FACE_CROPS=1 (see worker/index.ts). One-off runs can be enqueued
// deliberately via `enqueueBackfillFaceCrops()`.

import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { maintenanceQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";
import {
  generateFaceCropsForAsset,
  type FaceBbox,
  type FaceCropTarget,
} from "@/lib/processing/faceCrop";

export const DEFAULT_BACKFILL_BATCH_SIZE = 25;

export interface BackfillFaceCropsResult {
  scanned: number;
  cropped: number;
  failed: number;
  /** True when the batch hit the limit — more faces likely remain. */
  more: boolean;
}

function parseBbox(raw: unknown): FaceBbox | null {
  const b = raw as
    | { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
    | null
    | undefined;
  if (
    !b ||
    typeof b.x !== "number" ||
    typeof b.y !== "number" ||
    typeof b.w !== "number" ||
    typeof b.h !== "number"
  ) {
    return null;
  }
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/**
 * Process one small batch of un-cropped faces. Resolves the source asset for
 * each face, generates the crop, and stamps `face_crop_key`. Groups by asset so
 * faces sharing an asset reuse a single source decode.
 */
export async function backfillFaceCrops(
  batchSize: number = DEFAULT_BACKFILL_BATCH_SIZE
): Promise<BackfillFaceCropsResult> {
  const log = logger.child({ component: "face-crop-backfill" });
  const limit = Math.max(1, Math.floor(batchSize));

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    log.warn("R2_BUCKET unset — cannot backfill face crops");
    return { scanned: 0, cropped: 0, failed: 0, more: false };
  }

  // Pull a batch of faces still missing a crop, joined to their asset so we
  // have everything needed to fetch the source. ORDER BY a stable column so
  // re-runs make forward progress instead of churning the same rows.
  const rows = await db
    .select({
      faceId: schema.faceInstances.id,
      assetId: schema.faceInstances.assetId,
      workspaceId: schema.faceInstances.workspaceId,
      bbox: schema.faceInstances.bbox,
      filename: schema.assets.filename,
      previewKey: schema.assets.previewKey,
    })
    .from(schema.faceInstances)
    .innerJoin(
      schema.assets,
      eq(schema.faceInstances.assetId, schema.assets.id)
    )
    .where(sql`${schema.faceInstances.faceCropKey} IS NULL`)
    .orderBy(schema.faceInstances.createdAt)
    .limit(limit);

  if (rows.length === 0) {
    return { scanned: 0, cropped: 0, failed: 0, more: false };
  }

  // Group faces by asset so each asset's source is decoded once.
  const byAsset = new Map<
    string,
    {
      workspaceId: string;
      assetId: string;
      filename: string;
      previewKey: string | null;
      faces: FaceCropTarget[];
    }
  >();
  let degenerate = 0;
  for (const r of rows) {
    const bbox = parseBbox(r.bbox);
    if (!bbox) {
      degenerate++;
      continue;
    }
    let group = byAsset.get(r.assetId);
    if (!group) {
      group = {
        workspaceId: r.workspaceId,
        assetId: r.assetId,
        filename: r.filename,
        previewKey: r.previewKey,
        faces: [],
      };
      byAsset.set(r.assetId, group);
    }
    group.faces.push({ faceId: r.faceId, bbox });
  }

  let cropped = 0;
  for (const group of byAsset.values()) {
    const crops = await generateFaceCropsForAsset(
      bucket,
      {
        workspaceId: group.workspaceId,
        assetId: group.assetId,
        filename: group.filename,
        previewKey: group.previewKey,
      },
      group.faces
    );
    for (const [faceId, key] of crops) {
      await db
        .update(schema.faceInstances)
        .set({ faceCropKey: key })
        .where(eq(schema.faceInstances.id, faceId));
      cropped++;
    }
  }

  const failed = rows.length - cropped;
  log.info(
    { scanned: rows.length, cropped, failed, degenerate },
    "face-crop backfill batch complete"
  );
  return {
    scanned: rows.length,
    cropped,
    failed,
    // If we filled the batch there are probably more; the scheduler / a manual
    // re-enqueue will pick them up next tick.
    more: rows.length === limit,
  };
}

/**
 * Enqueue a single one-off backfill batch onto the maintenance queue. This is
 * the deliberate trigger for the default-off backfill — call it (e.g. from an
 * admin route or a CLI) to kick a run without enabling the recurring schedule.
 */
export async function enqueueBackfillFaceCrops(
  batchSize?: number
): Promise<void> {
  // The maintenance queue is typed with an empty payload (its other jobs read
  // the world from Postgres); the backfill optionally carries a batchSize, so
  // cast the typed payload through.
  await maintenanceQueue().add(
    JobNames.BackfillFaceCrops,
    (batchSize ? { batchSize } : {}) as unknown as Record<string, never>
  );
}
