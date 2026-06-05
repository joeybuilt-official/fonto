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
// Four heuristics:
//   1. RAW+JPEG pairs — same `capturedAt` within `STACK_RAW_JPEG_THRESHOLD_S`
//      (default 2) AND same `cameraMake`/`cameraModel` AND one image/jpeg
//      member + one canonical RAW member (image/x-canon-cr2 etc, see
//      lib/mime.ts:RAW_MIME_TYPES).
//   2. Bursts — 3+ assets within `STACK_BURST_THRESHOLD_S` (default 5) from
//      the same camera. Pairs are intentionally skipped (likely an
//      intentional double, not a burst).
//   3. Screenshot-runs (Task 20) — 3+ `kind='screenshot'` assets within
//      `STACK_SCREENSHOT_RUN_THRESHOLD_S` (default 30). A rapid sequence of
//      screenshots (a scrolled conversation/article) is one logical capture.
//   4. Near-dups (Task 20) — 2+ images within
//      `STACK_NEARDUP_WINDOW_S` (default 60) whose pHash Hamming distance is
//      ≤ `STACK_NEARDUP_HAMMING` (default 4). Catches re-saves / minor edits.
//      Windowed by capture time so the scan stays O(n·w) and visually-similar
//      but unrelated photos taken far apart never collapse.
//
// All heuristics require:
//   - capturedAt IS NOT NULL (no EXIF date ⇒ can't reason about timing)
//   - capturedAt >= 1990-01-01 (pre-1990 = EXIF parse-fallback sentinel dates
//     like 1899/1970 that bulk-collapse unrelated imports into a fake "burst")
//   - stack_id IS NULL (no point re-suggesting members of an existing stack)
//   - lifecycle_state = 'active' (trashed/archived don't surface in UI)
//
// Output is sorted deterministically (by earliest capturedAt asc) so two
// consecutive calls return the same ordering.

import { db, schema } from "@/lib/db";
import { and, eq, isNull, isNotNull, asc, inArray, sql } from "drizzle-orm";
import { RAW_MIME_TYPES } from "@/lib/mime";
import { hammingDistance, phashFromDb } from "@/lib/perceptual";

export type SuggestionReason = "raw+jpeg" | "burst" | "screenshot-run" | "near-dup";

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
  kind: string | null;
  phash: bigint | null;
}

// EXIF date parsers fall back to epoch/zero dates (1899-11-30, 1970-01-01)
// when a file carries no real capture time; dozens of unrelated imports then
// share one sentinel timestamp and look like a giant burst. No digital photo
// predates 1990, so anything earlier is bad data — excluded at query time.
const SENTINEL_CUTOFF = "1990-01-01";

function screenshotRunThresholdMs(): number {
  const raw = process.env.STACK_SCREENSHOT_RUN_THRESHOLD_S;
  const n = raw ? Number(raw) : 30;
  return (Number.isFinite(n) && n > 0 ? n : 30) * 1000;
}

function nearDupWindowMs(): number {
  const raw = process.env.STACK_NEARDUP_WINDOW_S;
  const n = raw ? Number(raw) : 60;
  return (Number.isFinite(n) && n > 0 ? n : 60) * 1000;
}

function nearDupHamming(): number {
  const raw = process.env.STACK_NEARDUP_HAMMING;
  const n = raw ? Number(raw) : 4;
  return Number.isFinite(n) && n >= 0 ? n : 4;
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
      kind: schema.assets.kind,
      phash: schema.assets.phash,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        isNull(schema.assets.stackId),
        isNotNull(schema.assets.capturedAt),
        sql`${schema.assets.capturedAt} >= ${SENTINEL_CUTOFF}`
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

  // --- Screenshot-run pass ----------------------------------------------
  // A rapid sequence of screenshots (kind='screenshot') is one logical
  // capture. Walk the screenshot rows in capture order and gather runs where
  // each consecutive gap is within the run window; emit runs of >= 3. No
  // camera-key gate (screenshots carry no camera EXIF). Burst members are
  // already excluded (a screenshot can't also be a camera burst, but the
  // exclusion keeps the sets disjoint).
  const screenshotRuns: StackSuggestion[] = [];
  const usedInRun = new Set<string>();
  const runWindowMs = screenshotRunThresholdMs();
  const shots = rows.filter((r) => r.kind === "screenshot" && !usedInBurst.has(r.id));

  let shotStart = 0;
  for (let i = 1; i <= shots.length; i++) {
    const prev = shots[i - 1];
    const cur = i < shots.length ? shots[i] : null;
    const prevTime = prev.capturedAt?.getTime() ?? 0;
    const curTime = cur?.capturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const withinWindow = cur ? curTime - prevTime <= runWindowMs : false;
    if (cur && withinWindow) continue;

    const runLen = i - shotStart;
    if (runLen >= 3) {
      const ids = shots.slice(shotStart, i).map((r) => r.id);
      screenshotRuns.push({ assetIds: ids, reason: "screenshot-run" });
      for (const id of ids) usedInRun.add(id);
    }
    shotStart = i;
  }

  // --- RAW+JPEG pass -----------------------------------------------------
  // Pair candidates with their next neighbour where the time delta is
  // within `rawJpegWindowMs`, the camera matches, AND the mime pair is one
  // jpeg + one raw. Both members must not already be inside a burst or
  // screenshot-run (those already cover them).
  const rawJpegPairs: StackSuggestion[] = [];
  const usedInPair = new Set<string>();

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    if (usedInBurst.has(a.id) || usedInRun.has(a.id) || usedInPair.has(a.id)) continue;
    const at = a.capturedAt?.getTime() ?? 0;

    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      const bt = b.capturedAt?.getTime() ?? 0;
      if (bt - at > rawJpegWindowMs) break;
      if (usedInBurst.has(b.id) || usedInRun.has(b.id) || usedInPair.has(b.id)) continue;
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

  // --- Near-dup pass -----------------------------------------------------
  // Cluster images that are visually near-identical (pHash Hamming ≤ N) AND
  // captured within the near-dup window of each other. Windowing bounds the
  // scan (O(n·w)) and prevents collapsing similar-but-unrelated photos taken
  // far apart. Members already claimed by a burst/run/pair are skipped.
  const nearDups: StackSuggestion[] = [];
  const usedInDup = new Set<string>();
  const dupWindowMs = nearDupWindowMs();
  const maxHamming = nearDupHamming();

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (a.phash === null) continue;
    if (usedInBurst.has(a.id) || usedInRun.has(a.id) || usedInPair.has(a.id) || usedInDup.has(a.id)) {
      continue;
    }
    const at = a.capturedAt?.getTime() ?? 0;
    const aHash = phashFromDb(a.phash);
    const cluster = [a.id];

    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      const bt = b.capturedAt?.getTime() ?? 0;
      if (bt - at > dupWindowMs) break;
      if (b.phash === null) continue;
      if (usedInBurst.has(b.id) || usedInRun.has(b.id) || usedInPair.has(b.id) || usedInDup.has(b.id)) {
        continue;
      }
      if (hammingDistance(aHash, phashFromDb(b.phash)) <= maxHamming) {
        cluster.push(b.id);
        usedInDup.add(b.id);
      }
    }

    if (cluster.length >= 2) {
      usedInDup.add(a.id);
      nearDups.push({ assetIds: cluster, reason: "near-dup" });
    }
  }

  // Bursts first (largest/most interesting), then screenshot-runs, then
  // RAW+JPEG pairs, then near-dups. Within each group the underlying scan
  // already orders by ascending capturedAt of the earliest member.
  return [...bursts, ...screenshotRuns, ...rawJpegPairs, ...nearDups];
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
