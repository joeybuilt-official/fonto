// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 / M1 — give the JPEG-XR DNGs that have NO full-resolution sibling a
// real thumbnail, by copying the derivatives of the low-resolution sibling that
// already renders.
//
// Context: docs/claude/platform/jxr-unrenderable-dngs/phase4-preview-unavailable-plan.md
//
// 1,548 DNGs cannot be thumbnailed because their pixel tiles are JPEG XR and
// nothing in the image decodes it. An expert panel unanimously refused to put a
// JXR decoder in the production runtime, and this script does NOT reopen that:
// it decodes nothing. Every asset it touches already has a sibling in the
// library whose derivatives were generated from an ordinary JPEG, so the work
// here is a server-side object copy plus a row update.
//
// Scope is deliberately narrow. Of the 1,548, some 1,531 have a FULL-RESOLUTION
// sibling (>=1MB) that already appears in the grid — giving those a thumbnail
// too would put a second identical tile next to the first, which is the grid
// noise the UX review called out. They keep thumbnail_state='skipped' and get
// the explaining tile instead (M2). This script targets only the residue whose
// sole sibling is a small preview, where the frame is otherwise represented in
// the grid by nothing at all.
//
// Sibling identification is by FILENAME CONTENT HASH, not by EXIF: these files
// are named `<prefix>_<40hex>_<40hex>` and the DNG, CR2 and JPEG of one frame
// share both hashes verbatim, which is direct evidence rather than inference.
// (The capture-time join under-counts here precisely because the small `t_`
// previews carry no DateTimeOriginal.)
//
// Idempotent: copies overwrite, and the row update is a plain SET. Reversible:
// clear the derivative keys and set thumbnail_state back to 'skipped'.
//
// Usage:
//   tsx scripts/backfill-proxy-thumbnails.ts --dry-run
//   tsx scripts/backfill-proxy-thumbnails.ts
//   tsx scripts/backfill-proxy-thumbnails.ts --limit=5
//
// Reads DATABASE_URL from env (and the storage backend's own configuration).

import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { storage } from "@/lib/storage";
import { assetDerivativeKey, assetResponsiveDerivativeKey } from "@/lib/r2";

const log = logger.child({ script: "backfill-proxy-thumbnails" });

/** A sibling is "full resolution" at or above this size; below it is a preview. */
const FULL_RES_MIN_BYTES = 1_000_000;

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  return flag.includes("=") ? flag.split("=")[1] : true;
}

/**
 * The derivative columns copied from sibling to target, paired with the key
 * helper that names the TARGET's own copy. Nothing is shared: each asset ends
 * up owning its derivatives, so deletion and GC stay correct.
 */
const DERIVATIVES = [
  { col: "thumbnailKey", key: (w: string, a: string) => assetDerivativeKey(w, a, "thumb") },
  { col: "previewKey", key: (w: string, a: string) => assetDerivativeKey(w, a, "preview") },
  { col: "thumbnail256AvifKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "thumb_256_avif") },
  { col: "thumbnail512WebpKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "thumb_512_webp") },
  { col: "thumbnail512AvifKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "thumb_512_avif") },
  { col: "thumbnail1024WebpKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "thumb_1024_webp") },
  { col: "thumbnail1024AvifKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "thumb_1024_avif") },
  { col: "previewAvifKey", key: (w: string, a: string) => assetResponsiveDerivativeKey(w, a, "preview_avif") },
] as const;

interface Candidate {
  asset_id: string;
  workspace_id: string;
  sibling_id: string;
  sibling_filename: string;
}

async function main(): Promise<void> {
  const dryRun = !!arg("dry-run");
  const limit = arg("limit") ? parseInt(String(arg("limit")), 10) : null;

  // Candidates: a skipped DNG whose BEST sibling — by filename hash or by
  // capture time, whichever finds a bigger one — is below the full-resolution
  // threshold, paired with the largest small sibling that actually has a
  // thumbnail to copy.
  const rows = (await db.execute(sql`
    WITH dng AS (
      SELECT id, workspace_id,
             exif->>'DateTimeOriginal' AS dto,
             substring(filename from '^[a-z]_([0-9a-f]{40})') AS h
      FROM fonto.assets
      WHERE deleted_at IS NULL
        AND mime_type = 'image/x-adobe-dng'
        AND thumbnail_state = 'skipped'
    ),
    sib AS (
      SELECT id, filename, size_bytes, thumbnail_key,
             exif->>'DateTimeOriginal' AS dto,
             substring(filename from '^[a-z]_([0-9a-f]{40})') AS h
      FROM fonto.assets
      WHERE deleted_at IS NULL
        AND mime_type <> 'image/x-adobe-dng'
        AND thumbnail_key IS NOT NULL
    ),
    -- Aggregate once per key, then LEFT JOIN. Written this way deliberately:
    -- the correlated-subquery form (max(size_bytes) per DNG) re-scans the
    -- 227k-row sibling set 1,548 times and takes ~2 minutes, and a long read on
    -- the assets table is exactly what queues in front of a concurrent ALTER and
    -- stalls every other query on the table. Aggregate CTEs return in seconds.
    sib_by_hash AS (
      SELECT h, max(size_bytes) AS mx FROM sib WHERE h IS NOT NULL GROUP BY h
    ),
    sib_by_time AS (
      SELECT dto, max(size_bytes) AS mx FROM sib WHERE dto IS NOT NULL GROUP BY dto
    ),
    -- Narrow to the target set BEFORE the lateral, so the "pick the best
    -- sibling" scan runs for ~17 rows rather than all 1,548.
    targets AS (
      SELECT d.id, d.workspace_id, d.h
      FROM dng d
      LEFT JOIN sib_by_hash bh ON bh.h = d.h
      LEFT JOIN sib_by_time bt ON bt.dto = d.dto
      WHERE GREATEST(COALESCE(bh.mx, 0), COALESCE(bt.mx, 0)) < ${FULL_RES_MIN_BYTES}
    )
    SELECT t.id AS asset_id, t.workspace_id,
           s.id AS sibling_id, s.filename AS sibling_filename
    FROM targets t
    JOIN LATERAL (
      SELECT s.* FROM sib s WHERE s.h = t.h ORDER BY s.size_bytes DESC LIMIT 1
    ) s ON TRUE
    ORDER BY t.id
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `)) as unknown as Candidate[];

  log.info({ candidates: rows.length, dryRun }, "proxy-thumbnail backfill start");
  if (rows.length === 0) {
    log.info("nothing to do");
    return;
  }

  let done = 0;
  let copied = 0;
  const failures: Array<{ assetId: string; err: string }> = [];

  for (const row of rows) {
    const sibling = await db.query.assets.findFirst({
      where: eq(schema.assets.id, row.sibling_id),
    });
    if (!sibling) {
      failures.push({ assetId: row.asset_id, err: "sibling row vanished" });
      continue;
    }

    const updates: Record<string, string> = {};
    try {
      for (const d of DERIVATIVES) {
        const srcKey = sibling[d.col as keyof typeof sibling] as string | null;
        if (!srcKey) continue;
        const dstKey = d.key(row.workspace_id, row.asset_id);
        if (!dryRun) await storage().copy(srcKey, dstKey);
        updates[d.col] = dstKey;
        copied++;
      }
    } catch (err) {
      failures.push({
        assetId: row.asset_id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (Object.keys(updates).length === 0) {
      failures.push({ assetId: row.asset_id, err: "sibling had no derivatives" });
      continue;
    }

    if (!dryRun) {
      await db
        .update(schema.assets)
        .set({
          ...updates,
          // The sibling's LQIP describes the same frame, so it is correct here
          // and spares the grid a white flash on load.
          lqip: sibling.lqip,
          thumbnailState: "ready",
          thumbnailError: null,
          thumbnailGeneratedAt: new Date(),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.assets.id, row.asset_id));
    }

    done++;
    log.info(
      { assetId: row.asset_id, siblingId: row.sibling_id, derivatives: Object.keys(updates).length },
      dryRun ? "would adopt sibling derivatives" : "adopted sibling derivatives"
    );
  }

  log.info({ done, copied, failed: failures.length, dryRun }, "proxy-thumbnail backfill complete");
  for (const f of failures) log.error(f, "proxy-thumbnail backfill failure");
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "fatal");
    process.exit(1);
  });
