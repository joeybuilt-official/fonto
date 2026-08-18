// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot face-crop backfill driver.
//
// The Phase 1 backfill function in lib/processing/backfillFaceCrops.ts is
// designed for the recurring scheduler (one small batch per tick). This
// script invokes it directly in a tight loop, bypassing the maintenance
// queue's concurrency-of-1 throttle so a 20k-face workspace can finish in
// hours instead of weeks.
//
// Usage (run inside the fonto-worker container so all env + R2 + DB creds
// + sharp module are already in scope):
//
//   docker exec fonto-worker /app/node_modules/.bin/tsx \
//     /app/scripts/backfill-face-crops.ts --batch=100
//
// Optional flags:
//   --batch=N   batch size per backfill call (default 100). Higher = fewer
//               round-trips + same shared decode per asset; lower = less
//               memory pressure.
//   --max=N     stop after at most N total batches (default unlimited).
//
// Exits 0 when more=false (all uncropped faces processed) or after --max
// batches; non-zero on unhandled error.

import { backfillFaceCrops } from "@/lib/processing/backfillFaceCrops";

function arg(name: string): string | null {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!flag) return null;
  return flag.split("=")[1] ?? null;
}

async function main(): Promise<void> {
  const batch = Math.max(parseInt(arg("batch") ?? "100", 10), 1);
  const maxBatches = arg("max") ? Math.max(parseInt(arg("max")!, 10), 1) : Infinity;

  console.log(`[backfill-face-crops] start  batch=${batch}  max=${maxBatches}`);
  const t0 = Date.now();
  let totalCropped = 0;
  let totalFailed = 0;
  let totalScanned = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const r = await backfillFaceCrops(batch);
    batches++;
    totalScanned += r.scanned;
    totalCropped += r.cropped;
    totalFailed += r.failed;
    const rate = totalCropped / Math.max(1, (Date.now() - t0) / 1000);
    console.log(
      `[batch ${batches.toString().padStart(4)}]  scanned=${r.scanned}  cropped=${r.cropped}  failed=${r.failed}  more=${r.more}  | total: ${totalCropped} (${rate.toFixed(1)}/s)`
    );
    if (!r.more) break;
    // Gentle pause so we don't starve other queries on the same DB.
    await new Promise((res) => setTimeout(res, 50));
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    `[backfill-face-crops] done  batches=${batches}  scanned=${totalScanned}  cropped=${totalCropped}  failed=${totalFailed}  elapsed=${elapsed.toFixed(1)}s`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-face-crops] CRASH:", e);
  process.exit(1);
});
