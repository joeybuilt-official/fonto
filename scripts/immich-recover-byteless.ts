// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Recovery for the immich→fonto import: delete byte-less / failed-put asset rows
// so a subsequent --resume re-imports them cleanly. Needed because createAssetRow
// dedups on SHA-256: a row that exists but whose bytes never landed (syncState
// 'syncing'/'error' after a failed put) makes every later import of the same file
// dedup-match and skip the upload — leaving it permanently byte-less. Deleting the
// row first lets the re-import do a fresh insert + put.
//
// Guard: only deletes rows whose syncState is in --require-state (default
// "syncing,error") AND whose bytes are confirmed ABSENT in BOTH backends (so a row
// that actually has bytes, just a stale state, is repaired in place, not deleted).
//
// Usage:
//   tsx scripts/immich-recover-byteless.mts --workspace=<uuid> --shas=<sha,sha,...> \
//     [--require-state=syncing,error] [--apply]
// Without --apply it's a dry run (reports the plan, mutates nothing).

import fs from "node:fs";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { assetStorageKey } from "@/lib/r2";
import { r2, localFs } from "@/lib/storage";

function arg(name: string): string | null {
  const f = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f === `--${name}` ? "" : f.split("=").slice(1).join("=");
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function bytesPresent(workspaceId: string, id: string, filename: string): Promise<boolean> {
  const key = assetStorageKey(workspaceId, id, filename);
  let r2ok = false;
  let localOk = false;
  try {
    await r2().stat(key);
    r2ok = true;
  } catch {
    /* absent */
  }
  try {
    await localFs().stat(key);
    localOk = true;
  } catch {
    /* absent */
  }
  return r2ok && localOk;
}

async function main(): Promise<void> {
  const workspaceId = arg("workspace");
  const shasRaw = arg("shas");
  const shasFile = arg("shas-file");
  const apply = flag("apply");
  const requireState = (arg("require-state") || "syncing,error").split(",").map((s) => s.trim());
  if (!workspaceId) throw new Error("--workspace=<uuid> required");
  if (!shasRaw && !shasFile) throw new Error("one of --shas=<sha,...> or --shas-file=<path> required");
  const rawShas = shasFile
    ? fs.readFileSync(shasFile, "utf8").split(/\s+/)
    : (shasRaw || "").split(",");
  const shas = [...new Set(rawShas.map((s) => s.trim()).filter(Boolean))];

  const rows = await db
    .select({
      id: schema.assets.id,
      sha256: schema.assets.sha256,
      filename: schema.assets.filename,
      syncState: schema.assets.syncState,
      lifecycleState: schema.assets.lifecycleState,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        inArray(schema.assets.sha256, shas)
      )
    );

  const toDelete: typeof rows = [];
  const toRepair: typeof rows = [];
  const skipped: string[] = [];

  for (const r of rows) {
    if (!requireState.includes(r.syncState)) {
      skipped.push(`${r.sha256} state=${r.syncState} (not in require-state) — SKIP`);
      continue;
    }
    const present = await bytesPresent(workspaceId, r.id, r.filename);
    if (present) toRepair.push(r);
    else toDelete.push(r);
  }

  const foundShas = new Set(rows.map((r) => r.sha256));
  const notFound = shas.filter((s) => !foundShas.has(s));

  console.log(`[recover] workspace=${workspaceId} apply=${apply}`);
  console.log(`[recover] requested shas=${shas.length} found rows=${rows.length} notFoundShas=${notFound.length}`);
  console.log(`[recover] toDelete(byte-less)=${toDelete.length} toRepair(bytes present, stale state)=${toRepair.length} skipped=${skipped.length}`);
  for (const s of skipped) console.log(`[recover]   ${s}`);
  for (const r of toDelete) console.log(`[recover]   DELETE ${r.sha256} id=${r.id} ${r.filename} (${r.syncState})`);
  for (const r of toRepair) console.log(`[recover]   REPAIR ${r.sha256} id=${r.id} ${r.filename} -> synced`);
  if (notFound.length) for (const s of notFound) console.log(`[recover]   NOT-FOUND ${s}`);

  if (!apply) {
    console.log(`[recover] dry run — re-run with --apply to mutate`);
    process.exit(0);
  }

  for (const r of toRepair) {
    await db
      .update(schema.assets)
      .set({ syncState: "synced" })
      .where(eq(schema.assets.id, r.id));
  }
  // Children reference asset_id; remove uploads + faces first if present, then the row.
  for (const r of toDelete) {
    try {
      await db.delete(schema.assetUploads).where(eq(schema.assetUploads.assetId, r.id));
    } catch {
      /* table/col may not exist in this schema build — ignore */
    }
    try {
      await db.delete(schema.faceInstances).where(eq(schema.faceInstances.assetId, r.id));
    } catch {
      /* ignore */
    }
    await db.delete(schema.assets).where(eq(schema.assets.id, r.id));
  }
  console.log(`[recover] APPLIED: deleted=${toDelete.length} repaired=${toRepair.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
