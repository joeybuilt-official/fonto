// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — backfill motion (Live) photos for already-imported assets.
//
// Two passes, both reversible + idempotent:
//   1. Android — re-scan image originals for an embedded MP4 (appended after
//      the JPEG EOI), slice it out, upload `motion.mp4`, and stamp
//      motion_photo + motion_video_key. NO re-encode of thumbnails — this only
//      copies bytes, so it's far cheaper than re-running the thumbnail job.
//   2. Apple — pair separate `.MOV` siblings to their stills (workspace
//      reconcile), hiding the MOV behind the still's LIVE badge.
//
// By default the Android pass only downloads images whose FILENAME hints at a
// motion photo (Google/Pixel markers) to bound cost on a large library; pass
// --all to byte-scan every JPEG (catches Samsung + marker-less encoders).
//
// Usage (run inside the worker container so @/lib + R2 env resolve):
//   tsx scripts/backfill-motion-photos.ts                       # all workspaces
//   tsx scripts/backfill-motion-photos.ts --workspace=<id>
//   tsx scripts/backfill-motion-photos.ts --all                 # scan every JPEG
//   tsx scripts/backfill-motion-photos.ts --limit=500 --dry-run
//   tsx scripts/backfill-motion-photos.ts --skip-extract        # pairing only
//   tsx scripts/backfill-motion-photos.ts --skip-pairing        # extraction only

import { sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { storage } from "@/lib/storage";
import { assetStorageKey, assetMotionKey } from "@/lib/r2";
import { nextSeq } from "@/lib/db/seq";
import { findEmbeddedMotionVideo } from "@/lib/processing/extractMotionPhoto";
import { reconcileWorkspaceMotion } from "@/lib/processing/motionPairing";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

// Google / Pixel motion-photo filename markers. Samsung + some encoders carry
// no marker → use --all for an exhaustive scan.
const FILENAME_HINT = sql`(
  filename ILIKE '%MVIMG%'
  OR filename ILIKE '%.MP.jpg'
  OR filename ILIKE '%MP.jpg'
  OR filename ILIKE '%motion%'
)`;

async function targetWorkspaces(): Promise<string[]> {
  const ws = arg("workspace");
  if (typeof ws === "string") return [ws];
  const rows = (await db.execute(
    sql`SELECT DISTINCT workspace_id FROM fonto.assets WHERE lifecycle_state = 'active'`,
  )) as unknown as Array<{ workspace_id: string }>;
  return rows.map((r) => r.workspace_id);
}

async function main(): Promise<void> {
  const batchSize = Math.max(parseInt(String(arg("batch") ?? "200"), 10), 1);
  const limit = arg("limit") ? parseInt(String(arg("limit")), 10) : Infinity;
  const all = !!arg("all");
  const dryRun = !!arg("dry-run");
  const skipExtract = !!arg("skip-extract");
  const skipPairing = !!arg("skip-pairing");

  const workspaces = await targetWorkspaces();
  console.log(
    `[backfill-motion] start ws=${workspaces.length} all=${all} dryRun=${dryRun}`,
  );

  const stats = { scanned: 0, extracted: 0, paired: 0, errors: 0 };

  // ── Pass 1: Android embedded-MP4 extraction.
  if (!skipExtract) {
    for (const workspaceId of workspaces) {
      let cursorCreatedAt: string | null = null;
      let cursorId: string | null = null;
      for (;;) {
        if (stats.scanned >= limit) break;
        const hint = all ? sql`TRUE` : FILENAME_HINT;
        const rows = (cursorCreatedAt && cursorId
          ? await db.execute(sql`
              SELECT id, workspace_id, filename, created_at::text AS created_at
              FROM fonto.assets
              WHERE workspace_id = ${workspaceId}
                AND lifecycle_state = 'active'
                AND mime_type LIKE 'image/%'
                AND motion_video_key IS NULL
                AND ${hint}
                AND (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
              ORDER BY created_at DESC, id DESC
              LIMIT ${batchSize}
            `)
          : await db.execute(sql`
              SELECT id, workspace_id, filename, created_at::text AS created_at
              FROM fonto.assets
              WHERE workspace_id = ${workspaceId}
                AND lifecycle_state = 'active'
                AND mime_type LIKE 'image/%'
                AND motion_video_key IS NULL
                AND ${hint}
              ORDER BY created_at DESC, id DESC
              LIMIT ${batchSize}
            `)) as unknown as Array<{
          id: string;
          workspace_id: string;
          filename: string;
          created_at: string;
        }>;
        if (rows.length === 0) break;

        for (const r of rows) {
          if (stats.scanned >= limit) break;
          stats.scanned++;
          try {
            const original = await storage().getBuffer(
              assetStorageKey(r.workspace_id, r.id, r.filename),
            );
            const motion = findEmbeddedMotionVideo(original);
            if (!motion) continue;
            if (dryRun) {
              console.log(
                `[backfill-motion] would extract ${r.id} (${r.filename}) clip=${motion.length}B`,
              );
              stats.extracted++;
              continue;
            }
            const clip = original.subarray(
              motion.offset,
              motion.offset + motion.length,
            );
            const key = assetMotionKey(r.workspace_id, r.id);
            await storage().put(key, clip, {
              contentType: "video/mp4",
              contentLength: clip.length,
              cacheControl: "public, max-age=31536000, immutable",
            });
            await db
              .update(schema.assets)
              .set({
                motionPhoto: true,
                motionVideoKey: key,
                seq: await nextSeq(r.workspace_id, "asset"),
              })
              .where(eq(schema.assets.id, r.id));
            stats.extracted++;
            console.log(
              `[backfill-motion] extracted ${r.id} (${r.filename}) clip=${clip.length}B`,
            );
          } catch (err) {
            stats.errors++;
            console.warn(
              `[backfill-motion] extract failed ${r.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        const last = rows[rows.length - 1];
        cursorCreatedAt = last.created_at;
        cursorId = last.id;
        if (rows.length < batchSize) break;
      }
    }
  }

  // ── Pass 2: Apple separate-file pairing.
  if (!skipPairing && !dryRun) {
    for (const workspaceId of workspaces) {
      try {
        const n = await reconcileWorkspaceMotion(workspaceId);
        stats.paired += n;
        if (n > 0) console.log(`[backfill-motion] paired ${n} in ws=${workspaceId}`);
      } catch (err) {
        stats.errors++;
        console.warn(
          `[backfill-motion] pairing failed ws=${workspaceId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  console.log(`[backfill-motion] complete: ${JSON.stringify(stats)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-motion] fatal:", e);
  process.exit(1);
});
