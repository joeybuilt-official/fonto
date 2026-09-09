// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase C2 (2026-09-09) — one-off, out-of-queue thumbnail generation for the
// video originals over `generateThumbnails.ts`'s 5GiB
// `THUMBNAIL_MAX_STREAMED_BYTES` ceiling. See
// docs/claude/platform/consolidation-2026-09/plan.md, decision C2, and the
// 2026-09-09 read-only investigation this follows up on.
//
// The ceiling exists to guard WORKER CONCURRENCY SLOT exhaustion — three
// giant QuickTime originals held all worker slots for ~12h on 2026-08-31 —
// not because ffmpeg needs the whole file: `extractVideoThumbnail.ts` seeks
// with `-ss` BEFORE `-i`, and ffmpeg's demuxer only needs to scan box
// headers for a seekable MOV/MP4 container once it's local, not the
// multi-GB body. This script never touches a worker concurrency slot: it
// runs standalone, concurrency=1, and calls the EXACT SAME
// `generateThumbnails()` (and therefore `extractVideoThumbnail()`) the
// worker calls — no ffmpeg invocation is reimplemented here. The size
// ceiling is bypassed ONLY in this process's own env
// (`THUMBNAIL_MAX_STREAMED_BYTES`), for the explicit rows below; the
// worker's own env, and therefore the ceiling it enforces on every other
// job, is untouched.
//
// Sibling-copy (the 2026-09-01 JPEG-XR-DNG `backfill-proxy-thumbnails.ts`
// precedent) was CONSIDERED and NOT used: the 2026-09-09 investigation
// described `c9d2f3b6`+`7ebc7105` and `9bd7f591`+`5214d648` as
// duplicate-content pairs by matching filename pattern + exact
// `size_bytes`, but a live requery immediately before this script was
// written shows each pair's two rows carry DIFFERENT `sha256` — so they are
// NOT verified byte-identical, and copying one row's derivative onto the
// other's would risk showing the wrong frame for a real difference between
// the two files. All 5 rows are generated independently instead
// (pre-approved fallback — downloading each is acceptable when the
// dup-pair trick isn't safely applicable).
//
// The 6th candidate from the investigation (`611212fd`, `video/MP2P` .mpg,
// 20.3GB) is explicitly OUT OF SCOPE and untouched by this script — MPEG
// program-stream has no compact box-header index the way MOV/MP4 does, so a
// bounded seek can't avoid an unbounded forward scan. Stays
// `thumbnail_state='skipped'`.
//
// Idempotent: `generateThumbnails()` overwrites the same derivative keys
// and re-stamps `thumbnailState`/`thumbnailGeneratedAt` on every call, so a
// retried or resumed run for an already-`ready` row just re-does the same
// work (or, here, is skipped outright — see the loop below).
//
// Known limitation: the per-file wall-clock guard races the
// `generateThumbnails()` promise against a timer and reports a clean
// failure on expiry, but does not (and structurally cannot, without
// reimplementing the download/ffmpeg invocation this script deliberately
// reuses unmodified) kill the in-flight download or ffmpeg child process.
// A timed-out row's underlying I/O may keep running in the background for
// a bounded extra time; the next row is only started after that promise
// settles (`for` loop, not `Promise.all`), so at most one extra file's
// worth of stray I/O is ever in flight.
//
// Usage — run inside the worker container (has DATABASE_URL + R2 creds +
// tsx + ffmpeg already configured):
//   node_modules/.bin/tsx scripts/backfill-oversized-video-thumbnails.ts --dry-run
//   node_modules/.bin/tsx scripts/backfill-oversized-video-thumbnails.ts --apply

import { inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { generateThumbnails } from "@/lib/processing/generateThumbnails";

const log = logger.child({ script: "backfill-oversized-video-thumbnails" });

// Exact rows identified by the 2026-09-09 investigation and reconfirmed by
// a live requery immediately before this script was written (see
// worklog.md). Hardcoded, not a live predicate query — deliberately: this
// is a one-off for a known, bounded, already-enumerated set, not a sweep
// that should silently pick up whatever else happens to match a
// size/mime-type predicate on a later re-run.
const ASSET_IDS = [
  "9bd7f591-1bf2-4cbd-acb9-da1422bcf64e", // 23030001.MOV, 18.19GB
  "7ebc7105-d0e3-49fc-93ad-250143936ec5", // r_cf62a558...mov, 18.53GB
  "c9d2f3b6-69dc-4b27-9c83-d8f2fd509b22", // 23030002.MOV, 18.53GB
  "5214d648-f1ce-4702-a19b-8a8bbe90d1dc", // r_cf6658f5...mov, 18.19GB
  "897d37a5-1599-44a9-8100-11bffc4bf10a", // r_3ed13292...mov, 14.24GB
];

// generateThumbnails() reads this env var itself (byteCeilingFromEnv in
// generateThumbnails.ts) — raising it here scopes the bypass to THIS
// process only. 21GiB comfortably clears the largest in-scope row
// (18.53GB) while staying below the excluded 20.3GB .mpg, so a future
// accidental id addition to this list involving that file would still trip
// the ceiling rather than silently proceeding.
const BYPASS_CEILING_BYTES = 21 * 1024 * 1024 * 1024;
process.env.THUMBNAIL_MAX_STREAMED_BYTES = String(BYPASS_CEILING_BYTES);

// Generous for an 18GB download + ffmpeg seek/decode over a real network
// link, while still failing clean instead of hanging indefinitely.
const PER_FILE_TIMEOUT_MS = 15 * 60 * 1000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms wall-clock timeout`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const dryRun = !apply;

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      sizeBytes: schema.assets.sizeBytes,
      thumbnailState: schema.assets.thumbnailState,
    })
    .from(schema.assets)
    .where(inArray(schema.assets.id, ASSET_IDS));

  if (rows.length !== ASSET_IDS.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ASSET_IDS.filter((id) => !found.has(id));
    throw new Error(
      `backfill-oversized-video-thumbnails: ${missing.length} id(s) not found: ${missing.join(", ")}`
    );
  }

  for (const r of rows) {
    if (r.mimeType !== "video/quicktime") {
      throw new Error(
        `${r.id}: expected video/quicktime, got '${r.mimeType}' — refusing to guess, aborting`
      );
    }
    if (r.thumbnailState !== "skipped" && r.thumbnailState !== "ready") {
      // 'ready' is allowed (a prior --apply pass already succeeded on a
      // resumed run); anything else — idle/generating/failed — is
      // unexpected drift from the investigated state, not something to
      // silently reprocess.
      throw new Error(
        `${r.id}: expected thumbnail_state='skipped', got '${r.thumbnailState}' — state drifted since the investigation, aborting`
      );
    }
  }

  log.info({ count: rows.length, dryRun }, "C2 oversized-video backfill start");
  for (const r of rows) {
    log.info(
      {
        id: r.id,
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        thumbnailState: r.thumbnailState,
      },
      dryRun ? "would generate" : "generating"
    );
  }
  if (dryRun) {
    log.info("dry-run — no writes. Re-run with --apply to execute.");
    return;
  }

  let succeeded = 0;
  const failures: Array<{ id: string; err: string }> = [];

  for (const r of rows) {
    if (r.thumbnailState === "ready") {
      log.info({ id: r.id }, "already ready — skipping (idempotent re-run)");
      succeeded++;
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        generateThumbnails({ assetId: r.id, workspaceId: r.workspaceId }),
        PER_FILE_TIMEOUT_MS,
        r.id
      );
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result.skipped) {
        throw new Error(`generateThumbnails returned skipped (reason: ${result.reason})`);
      }
      log.info(
        { id: r.id, elapsedSec, thumbnailKey: result.thumbnailKey },
        "OK — thumbnail generated"
      );
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ id: r.id, err: message }, "FAILED");
      failures.push({ id: r.id, err: message });
    }
  }

  log.info({ succeeded, failed: failures.length }, "C2 oversized-video backfill complete");
  for (const f of failures) log.error(f, "backfill-oversized-video-thumbnails failure");
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "fatal");
    process.exit(1);
  });
