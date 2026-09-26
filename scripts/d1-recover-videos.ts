// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// D1 recovery — the 13 QuickTime originals lost to the 2026-07-06
// legacy-importer timeout bug (see
// docs/claude/platform/consolidation-2026-09/plan.md, decision D1). Root
// cause already closed: the legacy buffer-based immich-import.ts hit its
// 180s per-file timeout on these ~2GB files — the DB row inserted, the R2
// upload never completed, and a later retry pass sha256-matched the row and
// logged "deduplicated" without ever uploading bytes. Untouched originals
// still sit in the pre-import staging directory.
//
// For each asset this script:
//   1. Locates the staging file by the DB row's own filename and verifies its
//      byte size against assets.size_bytes (loud skip on mismatch — never
//      guesses).
//   2. Copies (never moves) it to the asset's canonical local-mirror path via
//      localFs().put() — the same storage-facade call lib/storage/sync.ts
//      uses, not a hand-rolled fs write.
//   3. Pushes the canonical local copy up to R2 via r2().put() — the
//      identical call lib/storage/reconcile.ts's reheal-r2 branch makes when
//      it finds a local-present/R2-absent divergence for a mirror-policy
//      asset. Skipped if R2 already has the object (idempotent re-run).
//   4. Verifies the R2 object landed with a HEAD-equivalent stat() call and
//      that its size matches.
//   5. Stamps assets.local_original_stored_at, NULL-guarded exactly like
//      lib/storage/sync.ts's syncAssetStorage, so the row ends up
//      indistinguishable from one the normal storage-sync job mirrored
//      end-to-end (the pinned storage-sync-<assetId> jobs were failing
//      because they pull R2→local and R2 never had the bytes — this script
//      supplies the missing R2 upload that job could never perform itself).
//
// Usage:
//   tsx scripts/d1-recover-videos.ts --dry-run
//   tsx scripts/d1-recover-videos.ts --apply

import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";
import { isMissingObjectError } from "@/lib/storage/read";

const STAGING_DIR = path.join(
  // LOCAL_STORAGE_ROOT has no committed default: this is a one-off recovery
  // script bound to the operator's own local-storage mount.
  process.env.LOCAL_STORAGE_ROOT!,
  "_laptop-import-2026-07-05/Canon"
);

const ASSET_IDS = [
  "91c7b0ed-a1b1-40de-8299-90309db4cbce",
  "a3a7ac2d-77f4-4743-86b6-8c04cca908ba",
  "448c5bd8-0a09-4c80-970d-3aff60e8caed",
  "313684d0-a0f7-4a29-ba4e-211f71c2bf1f",
  "e6d2321f-02be-4073-b19b-4eaec7fdf4c1",
  "6cc110b0-ec49-4b80-89a0-0f1a5743feb0",
  "3754ccf3-bd93-43d1-8ad8-91098d5b5f32",
  "642a5315-9422-419b-a0c2-3ca0e076d458",
  "b223b396-125e-4620-b9da-88fbe4cad1c4",
  "96c69f21-ec99-4f2e-abc3-64e9c6210d2d",
  "bec89afb-81ca-41a6-bf77-9e620c400071",
  "24fe73c8-1250-44e3-9f7f-2a295fd4e8b8",
  "2b812d82-4a8a-4797-8c21-1d50d211fd69",
];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag("apply");

  const rows = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      sizeBytes: schema.assets.sizeBytes,
      localOriginalStoredAt: schema.assets.localOriginalStoredAt,
    })
    .from(schema.assets)
    .where(inArray(schema.assets.id, ASSET_IDS));

  if (rows.length !== ASSET_IDS.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ASSET_IDS.filter((id) => !found.has(id));
    throw new Error(`d1-recover-videos: ${missing.length} id(s) not found: ${missing.join(", ")}`);
  }

  let recovered = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `${row.id} ${row.filename}`;
    const srcPath = path.join(STAGING_DIR, row.filename);

    let srcStat: fs.Stats;
    try {
      srcStat = fs.statSync(srcPath);
    } catch (err) {
      console.error(`SKIP ${label}: staging file missing at ${srcPath} (${(err as Error).message})`);
      failed++;
      continue;
    }
    if (srcStat.size !== row.sizeBytes) {
      console.error(
        `SKIP ${label}: staging size ${srcStat.size} != assets.size_bytes ${row.sizeBytes}`
      );
      failed++;
      continue;
    }

    const key = assetStorageKey(row.workspaceId, row.id, row.filename);

    if (!apply) {
      console.log(`PLAN ${label}: ${srcPath} (${srcStat.size}B) -> local+R2 key ${key}`);
      continue;
    }

    try {
      // 1/2. Copy staging -> canonical local mirror path via the storage facade.
      await localFs().put(key, fs.createReadStream(srcPath), { contentType: row.mimeType });
      const localStat = await localFs().stat(key);
      if (localStat.contentLength !== row.sizeBytes) {
        throw new Error(
          `local copy size ${localStat.contentLength} != expected ${row.sizeBytes}`
        );
      }

      // 3. Push to R2 unless it's already there (idempotent re-run).
      let r2HasIt = false;
      try {
        await r2().stat(key);
        r2HasIt = true;
      } catch (err) {
        if (!isMissingObjectError(err)) throw err;
      }
      if (!r2HasIt) {
        await r2().put(key, fs.createReadStream(srcPath), {
          contentType: row.mimeType,
          contentLength: row.sizeBytes,
        });
      }

      // 4. Verify via a HEAD-equivalent stat().
      const r2Stat = await r2().stat(key);
      if (r2Stat.contentLength !== row.sizeBytes) {
        throw new Error(`R2 object size ${r2Stat.contentLength} != expected ${row.sizeBytes}`);
      }

      // 5. Stamp local_original_stored_at, NULL-guarded like syncAssetStorage.
      if (!row.localOriginalStoredAt) {
        await db
          .update(schema.assets)
          .set({ localOriginalStoredAt: new Date() })
          .where(and(eq(schema.assets.id, row.id), eq(schema.assets.workspaceId, row.workspaceId)));
      }

      console.log(`OK   ${label}: recovered, R2 size=${r2Stat.contentLength}`);
      recovered++;
    } catch (err) {
      console.error(`FAIL ${label}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(
    apply
      ? `done: ${recovered}/${rows.length} recovered, ${failed} failed`
      : `dry run — no writes. Re-run with --apply to execute.`
  );
  if (apply && failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
