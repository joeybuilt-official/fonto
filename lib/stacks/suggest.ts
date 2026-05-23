// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — Stack auto-suggestion.
//
// This module is READ-ONLY: it scans the workspace's assets and emits a list
// of candidate stacks for the user to confirm in the UI. It never writes to
// `fonto.stacks` or mutates `assets.stack_id`. Confirmation happens via
// `POST /api/v1/stacks/suggestions/accept`.
//
// Two heuristics:
//   1. RAW+JPEG pairs — same `capturedAt` within `STACK_RAW_JPEG_THRESHOLD_S`
//      (default 2) AND same `cameraMake`/`cameraModel` AND one image/jpeg
//      member + one canonical RAW member (image/x-canon-cr2 etc, see
//      lib/mime.ts:RAW_MIME_TYPES).
//   2. Bursts — 3+ assets within `STACK_BURST_THRESHOLD_S` (default 5) from
//      the same camera. Pairs are intentionally skipped (likely an
//      intentional double, not a burst).
//
// Both heuristics require:
//   - capturedAt IS NOT NULL (no EXIF date ⇒ can't reason about timing)
//   - stack_id IS NULL (no point re-suggesting members of an existing stack)
//   - lifecycle_state = 'active' (trashed/archived don't surface in UI)
//
// Output is sorted deterministically (by earliest capturedAt asc) so two
// consecutive calls return the same ordering.

import { db, schema } from "@/lib/db";
import { and, eq, isNull, isNotNull, asc, inArray } from "drizzle-orm";
import { RAW_MIME_TYPES } from "@/lib/mime";

export type SuggestionReason = "raw+jpeg" | "burst";

export interface StackSuggestion {
  assetIds: string[];
  reason: SuggestionReason;
}

interface AssetMinimal {
  id: string;
  capturedAt: Date | null;
  mimeType: string;
  cameraMake: string | null;
  cameraModel: string | null;
}

function rawJpegThresholdMs(): number {
  const raw = process.env.STACK_RAW_JPEG_THRESHOLD_S;
  const n = raw ? Number(raw) : 2;
  return (Number.isFinite(n) && n > 0 ? n : 2) * 1000;
}

function burstThresholdMs(): number {
  const raw = process.env.STACK_BURST_THRESHOLD_S;
  const n = raw ? Number(raw) : 5;
  return (Number.isFinite(n) && n > 0 ? n : 5) * 1000;
}

function cameraKey(a: AssetMinimal): string {
  // Empty/null make/model still cluster together — we only require that two
  // assets share the same identity tuple, not that the tuple is populated.
  return `${a.cameraMake ?? ""}::${a.cameraModel ?? ""}`;
}

function isJpeg(mime: string): boolean {
  const m = mime.toLowerCase();
  return m === "image/jpeg" || m === "image/jpg";
}

function isRaw(mime: string): boolean {
  return RAW_MIME_TYPES.has(mime.toLowerCase());
}

/**
 * Returns up to a few hundred suggested stacks for the workspace. Both
 * heuristics use the same single SQL pull (ordered by capturedAt) and walk
 * the result with a windowing pass — O(n) over candidate rows.
 *
 * Bursts win over RAW+JPEG when both heuristics would surface overlapping
 * assets: if a 4-shot burst includes a RAW+JPEG pair, the burst suggestion
 * covers it and the pair is suppressed.
 */
export async function suggestStacks(workspaceId: string): Promise<StackSuggestion[]> {
  const rows = (await db
    .select({
      id: schema.assets.id,
      capturedAt: schema.assets.capturedAt,
      mimeType: schema.assets.mimeType,
      cameraMake: schema.assets.cameraMake,
      cameraModel: schema.assets.cameraModel,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        isNull(schema.assets.stackId),
        isNotNull(schema.assets.capturedAt)
      )
    )
    .orderBy(asc(schema.assets.capturedAt))) as AssetMinimal[];

  if (rows.length === 0) return [];

  const burstWindowMs = burstThresholdMs();
  const rawJpegWindowMs = rawJpegThresholdMs();

  // --- Burst pass --------------------------------------------------------
  // Slide over the sorted-by-capturedAt array; gather runs where each
  // consecutive pair is within `burstWindowMs` AND shares the same camera
  // tuple. Only emit clusters of size >= 3 (pairs are likely intentional
  // doubles, not bursts).
  const bursts: StackSuggestion[] = [];
  const usedInBurst = new Set<string>();

  let runStart = 0;
  for (let i = 1; i <= rows.length; i++) {
    const prev = rows[i - 1];
    const cur = i < rows.length ? rows[i] : null;
    const prevTime = prev.capturedAt?.getTime() ?? 0;
    const curTime = cur?.capturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const sameCamera = cur ? cameraKey(prev) === cameraKey(rows[runStart]) : false;
    const withinWindow = cur ? curTime - prevTime <= burstWindowMs : false;

    if (cur && withinWindow && sameCamera) {
      // Extend run.
      continue;
    }

    // End of run [runStart, i). Emit if it qualifies as a burst (>=3).
    const runLen = i - runStart;
    if (runLen >= 3) {
      const ids = rows.slice(runStart, i).map((r) => r.id);
      bursts.push({ assetIds: ids, reason: "burst" });
      for (const id of ids) usedInBurst.add(id);
    }
    runStart = i;
  }

  // --- RAW+JPEG pass -----------------------------------------------------
  // Pair candidates with their next neighbour where the time delta is
  // within `rawJpegWindowMs`, the camera matches, AND the mime pair is one
  // jpeg + one raw. Both members must not already be inside a burst (the
  // burst already covers them).
  const rawJpegPairs: StackSuggestion[] = [];
  const usedInPair = new Set<string>();

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    if (usedInBurst.has(a.id) || usedInPair.has(a.id)) continue;
    const at = a.capturedAt?.getTime() ?? 0;

    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      const bt = b.capturedAt?.getTime() ?? 0;
      if (bt - at > rawJpegWindowMs) break;
      if (usedInBurst.has(b.id) || usedInPair.has(b.id)) continue;
      if (cameraKey(a) !== cameraKey(b)) continue;

      const aIsJpeg = isJpeg(a.mimeType);
      const aIsRaw = isRaw(a.mimeType);
      const bIsJpeg = isJpeg(b.mimeType);
      const bIsRaw = isRaw(b.mimeType);
      const pair = (aIsJpeg && bIsRaw) || (aIsRaw && bIsJpeg);
      if (!pair) continue;

      rawJpegPairs.push({ assetIds: [a.id, b.id], reason: "raw+jpeg" });
      usedInPair.add(a.id);
      usedInPair.add(b.id);
      break;
    }
  }

  // Bursts first (more interesting / larger), then pairs. Within each
  // group, the underlying scan already orders by ascending capturedAt of
  // the earliest member.
  return [...bursts, ...rawJpegPairs];
}

/**
 * Helper used by `POST /api/v1/stacks/suggestions/accept` and `POST
 * /api/v1/stacks` to validate that every asset id is alive in the given
 * workspace, returning the matching rows. Returns null if any id is
 * missing, trashed, archived, or in a different workspace.
 */
export async function loadAssetsForStack(
  workspaceId: string,
  assetIds: readonly string[]
): Promise<typeof schema.assets.$inferSelect[] | null> {
  if (assetIds.length === 0) return null;
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.id, assetIds as string[]),
        eq(schema.assets.workspaceId, workspaceId)
      )
    );
  if (rows.length !== assetIds.length) return null;
  return rows;
}
