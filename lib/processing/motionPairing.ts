// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — Apple Live Photo pairing.
//
// Apple stores a Live Photo as TWO separate files sharing a base name: the
// still (`IMG_1234.HEIC` / `.JPG`) and the clip (`IMG_1234.MOV`). Each imports
// as its own asset, so the library shows a redundant MOV tile next to the
// still. This reconcile links them: the still gets `motionCompanionAssetId`
// (+ `motionPhoto = true`) and the MOV gets `motionCompanion = true` so the
// library/grid/search read paths filter it out (one tile = one moment).
//
// Reversible: clearing the three columns restores the MOV as a normal asset.
// Idempotent: re-running skips already-paired MOVs.

import { and, eq, ilike, isNull, sql, lte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { nextSeq } from "@/lib/db/seq";
import { logger } from "@/lib/logger";

// A Live Photo clip is short — Apple caps it at ~3s, but transcodes + slop
// push real-world durations a touch higher. Anything longer is a real video,
// not a Live Photo companion.
const MAX_COMPANION_SECONDS = 6;
const DRIVE_PREFIX_RE = /^drive_[A-Za-z0-9_-]+_/;
const MOV_EXT_RE = /\.mov$/i;
const STILL_EXT_RE = /\.(heic|heif|jpe?g)$/i;

/** Strip a Drive import prefix + the file extension → the bare base name. */
function baseName(filename: string): string {
  return filename
    .replace(DRIVE_PREFIX_RE, "")
    .replace(/\.[^.]+$/, "");
}

/** Escape LIKE/ILIKE metacharacters in a user-derived pattern fragment. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * Try to pair one `.MOV` asset to its still sibling. No-op (returns false)
 * when the asset isn't a short MOV, is already a companion, or has no matching
 * still in the same directory. Safe to call opportunistically from the video
 * processing path AND from the workspace reconcile sweep.
 */
export async function pairAppleMotion(movAssetId: string): Promise<boolean> {
  const [mov] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      directoryPath: schema.assets.directoryPath,
      durationSeconds: schema.assets.durationSeconds,
      lifecycleState: schema.assets.lifecycleState,
      motionCompanion: schema.assets.motionCompanion,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, movAssetId))
    .limit(1);

  if (!mov) return false;
  if (mov.motionCompanion) return false; // already absorbed
  if (mov.lifecycleState !== "active") return false;
  const isMov =
    MOV_EXT_RE.test(mov.filename) || mov.mimeType === "video/quicktime";
  if (!isMov) return false;
  // Duration must be known + short. NULL = not probed yet → leave for a later
  // sweep once generateThumbnails has stamped durationSeconds.
  if (mov.durationSeconds == null || mov.durationSeconds > MAX_COMPANION_SECONDS) {
    return false;
  }

  const base = baseName(mov.filename);
  if (!base) return false;

  // Same workspace + same directory (null-aware) + image MIME + same base
  // name. directoryPath equality keeps two unrelated IMG_0001 from different
  // folders apart.
  const dirCond =
    mov.directoryPath == null
      ? isNull(schema.assets.directoryPath)
      : eq(schema.assets.directoryPath, mov.directoryPath);

  const candidates = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      motionPhoto: schema.assets.motionPhoto,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, mov.workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        ilike(schema.assets.mimeType, "image/%"),
        ilike(schema.assets.filename, `%${escapeLike(base)}.%`),
        dirCond,
      ),
    )
    .limit(25);

  // Exact base + image-extension match (the ilike is a coarse prefilter).
  const still = candidates.find(
    (c) =>
      baseName(c.filename).toLowerCase() === base.toLowerCase() &&
      STILL_EXT_RE.test(c.filename.replace(DRIVE_PREFIX_RE, "")),
  );
  if (!still) return false;

  // Link both rows + bump each seq so delta-sync propagates the hide + badge.
  await db
    .update(schema.assets)
    .set({
      motionPhoto: true,
      motionCompanionAssetId: mov.id,
      seq: await nextSeq(mov.workspaceId, "asset"),
    })
    .where(eq(schema.assets.id, still.id));
  await db
    .update(schema.assets)
    .set({
      motionCompanion: true,
      seq: await nextSeq(mov.workspaceId, "asset"),
    })
    .where(eq(schema.assets.id, mov.id));

  logger.info(
    { mov: mov.id, still: still.id, workspaceId: mov.workspaceId },
    "[motion] paired Apple Live Photo",
  );
  return true;
}

/**
 * Sweep a workspace for unpaired short `.MOV` assets and link each to its
 * still sibling. Idempotent + reversible. Returns the number of pairs made.
 * Used by the backfill script and re-runnable on demand.
 */
export async function reconcileWorkspaceMotion(workspaceId: string): Promise<number> {
  const movs = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.assets.motionCompanion, false),
        ilike(schema.assets.mimeType, "video/%"),
        ilike(schema.assets.filename, "%.mov"),
        lte(schema.assets.durationSeconds, MAX_COMPANION_SECONDS),
        sql`${schema.assets.durationSeconds} IS NOT NULL`,
      ),
    );

  let paired = 0;
  for (const m of movs) {
    if (await pairAppleMotion(m.id)) paired++;
  }
  return paired;
}
