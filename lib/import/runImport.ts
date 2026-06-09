// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — the import-job runner. Invoked by the BullMQ
// `media-import` worker (worker/index.ts) for one `import_jobs` row. Streams
// the archive (Google Drive Takeout, or — Phase 3 — a local Amazon ZIP),
// walks it member-by-member, and feeds each media file to `createAssetRow`
// with the Takeout sidecar metadata as an override.
//
// Design notes:
//  - Tens-of-GB safe: the archive is streamed to a temp file and walked one
//    member at a time (see takeoutArchive.ts). Peak RAM ≈ largest single
//    media file. The temp dir is removed eagerly in a `finally`.
//  - Resume: the row's `cursor` holds the last successfully-processed member
//    path. On (re)start the walk skips up to and including it. The BullMQ
//    queue is attempts:1, so resume is app-managed — a process restart re-runs
//    this function and picks up from the cursor.
//  - Progress: counts are flushed to `import_jobs` in batches of 25 and once
//    more on finish, per ADR C5 (avoid thousands of row UPDATEs).
//  - Reconnect: `getFreshAccessToken` throws `ReconnectRequiredError` on
//    invalid_grant; we set the job error + status='failed' and return WITHOUT
//    throwing, so the worker process never crashes.

import { rm } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import {
  getFreshAccessToken,
  ReconnectRequiredError,
} from "@/lib/integrations/google";
import {
  downloadDriveFileToTemp,
  getDriveFileMeta,
} from "./driveDownload";
import {
  listArchiveMembers,
  walkTakeoutMedia,
  looksLikeZip,
  isUnsupportedArchive,
} from "./takeoutArchive";

/** Flush counts to import_jobs every N successfully-handled members. */
const PROGRESS_BATCH = 25;

type ImportJobRow = typeof schema.importJobs.$inferSelect;

interface RunArgs {
  importJobId: string;
  workspaceId: string;
  userId: string;
  provider: "google-takeout" | "amazon-photos";
  driveFileId?: string;
  uploadTmpPath?: string;
}

/** Mutable running tally we periodically flush to the row. */
interface Counters {
  total: number;
  processed: number;
  deduped: number;
  failed: number;
  cursor: string | null;
}

export async function runImport(args: RunArgs): Promise<void> {
  const log = logger.child({
    component: "import.run",
    importJobId: args.importJobId,
    provider: args.provider,
  });

  const [job] = await db
    .select()
    .from(schema.importJobs)
    .where(eq(schema.importJobs.id, args.importJobId))
    .limit(1);
  if (!job) {
    log.warn("import_jobs row missing — dropping job");
    return;
  }
  if (job.status === "completed") {
    log.info("import already completed — skipping");
    return;
  }

  await db
    .update(schema.importJobs)
    .set({ status: "running", error: null, updatedAt: new Date() })
    .where(eq(schema.importJobs.id, args.importJobId));

  // Seed counters from the row so a resume continues the tallies.
  const counters: Counters = {
    total: job.itemsTotal,
    processed: job.itemsProcessed,
    deduped: job.itemsDeduped,
    failed: job.itemsFailed,
    cursor: job.cursor,
  };

  // Where the archive lives on disk + whether we own the temp dir to clean up.
  let zipPath: string;
  let tmpDirToClean: string | null = null;

  try {
    if (args.uploadTmpPath) {
      // Phase 3 (Amazon) reuse: the upload endpoint already streamed the ZIP
      // to disk. No Drive download, no sidecars.
      zipPath = args.uploadTmpPath;
    } else {
      // Phase 2 (Google Takeout): mint a token, stream the Drive file down.
      const accessToken = await resolveDriveAccessToken(args);
      if (!args.driveFileId) {
        await markFailed(args.importJobId, "missing driveFileId", counters);
        return;
      }
      const meta = await getDriveFileMeta(args.driveFileId, accessToken);
      log.info({ driveFileName: meta.name, sizeBytes: meta.size }, "downloading Drive archive");
      const dl = await downloadDriveFileToTemp(args.driveFileId, accessToken);
      zipPath = dl.tmpPath;
      tmpDirToClean = dl.tmpDir;
    }

    // Reject tarballs early (Phase 2 supports ZIP only).
    if (!(await looksLikeZip(zipPath)) || isUnsupportedArchive(args.driveFileId ?? null)) {
      await markFailed(
        args.importJobId,
        "Unsupported archive format (only Google Takeout .zip is supported)",
        counters,
      );
      return;
    }

    // Enumerate members up front so the sidecar matcher sees the full set.
    const memberNames = await listArchiveMembers(zipPath);
    // itemsTotal = count of media members (best-effort; exact set walked below).
    const mediaCount = countMedia(memberNames);
    counters.total = mediaCount;
    await flush(args.importJobId, counters);

    // For Amazon (uploadTmpPath) there are no sidecars; the walker simply
    // won't find any matches and `override` stays undefined → EXIF-only.
    const useSidecars = args.provider === "google-takeout";

    let sinceFlush = 0;
    for await (const member of walkTakeoutMedia(zipPath, memberNames, {
      resumeAfter: counters.cursor,
    })) {
      try {
        const result = await createAssetRow({
          workspaceId: args.workspaceId,
          userId: args.userId,
          filename: member.filename,
          mimeType: member.mime,
          sizeBytes: member.buffer.length,
          buffer: member.buffer,
          source: args.provider,
          directoryPath: member.albumDir,
          metadataOverride: useSidecars ? member.override : undefined,
        });
        if (result.deduplicated) counters.deduped += 1;
        else counters.processed += 1;
      } catch (err) {
        counters.failed += 1;
        log.warn(
          {
            member: member.memberPath,
            err: err instanceof Error ? err.message : String(err),
          },
          "import member failed — continuing",
        );
      }
      // Advance the resume cursor to this member regardless of outcome so a
      // restart doesn't re-attempt a member that's already been accounted for.
      counters.cursor = member.memberPath;
      sinceFlush += 1;
      if (sinceFlush >= PROGRESS_BATCH) {
        await flush(args.importJobId, counters);
        sinceFlush = 0;
      }
    }

    await db
      .update(schema.importJobs)
      .set({
        status: "completed",
        itemsTotal: counters.total,
        itemsProcessed: counters.processed,
        itemsDeduped: counters.deduped,
        itemsFailed: counters.failed,
        cursor: counters.cursor,
        updatedAt: new Date(),
      })
      .where(eq(schema.importJobs.id, args.importJobId));

    log.info(
      {
        processed: counters.processed,
        deduped: counters.deduped,
        failed: counters.failed,
        total: counters.total,
      },
      "import completed",
    );
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      // Token died mid-import. Checkpoint progress + flip to failed (the
      // integration row is already 'needs_reconnect'). Do NOT rethrow — a
      // throw would crash the single-attempt worker; the user reconnects and
      // re-runs, resuming from the cursor.
      await markFailed(
        args.importJobId,
        "Google connection expired — reconnect and re-run to resume",
        counters,
      );
      log.warn("import paused: Google reconnect required");
      return;
    }
    // Unexpected failure: checkpoint + mark failed, and rethrow so BullMQ logs
    // it (attempts:1 means no wasteful full-archive retry).
    await markFailed(
      args.importJobId,
      err instanceof Error ? err.message : String(err),
      counters,
    );
    log.error({ err: err instanceof Error ? err.message : String(err) }, "import failed");
    throw err;
  } finally {
    // Eager temp cleanup. For the Google Takeout path we own the whole temp dir
    // the Drive archive was streamed into. For the Phase 3 Amazon path the
    // upload endpoint streamed a single ZIP to a temp file and handed us its
    // path; once the walk is done (success, failure, or reconnect) that file is
    // no longer needed, so we unlink it here.
    if (tmpDirToClean) {
      await rm(tmpDirToClean, { recursive: true, force: true }).catch(() => undefined);
    }
    if (args.uploadTmpPath) {
      await rm(args.uploadTmpPath, { force: true }).catch(() => undefined);
    }
  }
}

/** Look up the Google integration row + mint a live Drive access token. */
async function resolveDriveAccessToken(args: RunArgs): Promise<string> {
  const [integration] = await db
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, args.workspaceId),
        eq(schema.integrations.userId, args.userId),
        eq(schema.integrations.provider, "google"),
      ),
    )
    .limit(1);
  if (!integration) {
    throw new ReconnectRequiredError(args.importJobId);
  }
  logger.info(
    { component: "import.run", importJobId: args.importJobId, integrationId: integration.id },
    "minting Drive access token",
  );
  return getFreshAccessToken(integration);
}

/** Count media members for the itemsTotal estimate (no byte reads). */
function countMedia(memberNames: string[]): number {
  let n = 0;
  for (const name of memberNames) {
    if (name.endsWith("/")) continue;
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = name.slice(dot + 1).toLowerCase();
    if (ext === "json") continue;
    // Heuristic media filter mirrors takeoutArchive.MEDIA_EXTS — kept loose
    // here (it's only the progress denominator, not the ingest gate).
    if (MEDIA_EXT_HINT.has(ext)) n += 1;
  }
  return n;
}

// Lightweight duplicate of the media-extension set for the total estimate.
const MEDIA_EXT_HINT = new Set<string>([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
  "hif", "avif", "cr2", "cr3", "dng", "arw", "srf", "sr2", "nef", "nrw", "rw2",
  "raw", "orf", "raf", "pef", "srw", "x3f", "mp4", "mov", "m4v", "3gp", "avi",
  "mkv", "webm", "mpg", "mpeg", "mts", "m2ts",
]);

/** Flush the running counters (and cursor) to the import_jobs row. */
async function flush(importJobId: string, c: Counters): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({
      itemsTotal: c.total,
      itemsProcessed: c.processed,
      itemsDeduped: c.deduped,
      itemsFailed: c.failed,
      cursor: c.cursor,
      updatedAt: new Date(),
    })
    .where(eq(schema.importJobs.id, importJobId));
}

/** Checkpoint counters + flip the job to failed with an error message. */
async function markFailed(
  importJobId: string,
  error: string,
  c: Counters,
): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({
      status: "failed",
      error: error.slice(0, 1000),
      itemsTotal: c.total,
      itemsProcessed: c.processed,
      itemsDeduped: c.deduped,
      itemsFailed: c.failed,
      cursor: c.cursor,
      updatedAt: new Date(),
    })
    .where(eq(schema.importJobs.id, importJobId));
}

export type { ImportJobRow };
