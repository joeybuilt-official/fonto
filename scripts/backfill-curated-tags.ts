// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot driver for the curated-tags rebuild (Explore > Things).
// Re-derives clean taxonomy tags from stored clip_vec for every asset with
// auto_tagged_at IS NULL. Cheap (cosine only) — runs in a tight loop.
//
//   docker exec -w /app fonto-worker \
//     /app/node_modules/.bin/tsx /app/scripts/backfill-curated-tags.ts --batch=200
//
//   --batch=N  assets per batch (default 200)
//   --max=N    stop after N batches (default unlimited)

import { backfillCuratedTags } from "@/lib/processing/backfillCuratedTags";

function arg(name: string): string | null {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? (flag.split("=")[1] ?? null) : null;
}

async function main(): Promise<void> {
  const batch = Math.max(parseInt(arg("batch") ?? "200", 10), 1);
  const maxBatches = arg("max") ? Math.max(parseInt(arg("max")!, 10), 1) : Infinity;
  console.log(`[backfill-curated-tags] start batch=${batch} max=${maxBatches}`);
  const t0 = Date.now();
  let batches = 0;
  let scanned = 0;
  let tagged = 0;
  while (batches < maxBatches) {
    const r = await backfillCuratedTags(batch);
    batches++;
    scanned += r.scanned;
    tagged += r.tagged;
    const rate = scanned / Math.max(1, (Date.now() - t0) / 1000);
    console.log(
      `[batch ${batches}] scanned=${r.scanned} tagged=${r.tagged} more=${r.more} | total scanned=${scanned} tagged=${tagged} (${rate.toFixed(0)}/s)`
    );
    if (!r.more) break;
  }
  console.log(
    `[backfill-curated-tags] done batches=${batches} scanned=${scanned} tagged=${tagged} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-curated-tags] CRASH:", e);
  process.exit(1);
});
