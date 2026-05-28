// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.1 — verify the CLIP zero-shot fix (commit 6e85410) is live in
// production. Run after any deploy that touches the classify pipeline.
//
// What this tests:
//   1. Loads taxonomy vectors via loadTaxonomyVectors() — exercises the exact
//      shape fix from 6e85410 (embedText returns { vector, modelId }; the bug
//      was treating the whole object as the numeric array, scoring every class
//      at 0 and falling through to LLM on 100% of images).
//   2. Finds the most-recent active image asset with clip_vec IS NOT NULL.
//   3. Calls classifyAsset() with that vec. The supplied LLM-fallback callback
//      throws, so a below-threshold confidence miss surfaces as a test failure
//      instead of silently passing via the fallback path.
//   4. Asserts result.method === 'clip'. EXIT 0 on pass, EXIT 1 on fail.
//
// Expected output on a healthy system:
//   [verify-clip] taxonomy vectors loaded (N top-level, M sub entries)
//   [verify-clip] candidate: <uuid> (<filename>)
//   [verify-clip] PASS — classify_method=clip topLevel=<class> confidence=0.xxxx
//
// Expected output if fix regressed (scores all 0 — objects instead of arrays):
//   [verify-clip] FAIL — CLIP confidence below threshold — fell through to LLM fallback
//   [verify-clip] asset: <uuid> (<filename>)
//
// Note: the runner-up delta gate (default 0.05) can cause fallback on borderline images
// even when CLIP is working. The script sets CLASSIFY_RUNNER_UP_DELTA=0 internally to
// bypass it; the production pipeline keeps the 0.05 default. A genuine regression
// (scores all 0) will fail even with delta=0 because the threshold check catches it.
//
// Usage:
//   pnpm verify:clip                      # most-recent image with clip_vec
//   pnpm verify:clip -- --asset=<uuid>    # specific asset
//
// Reads DATABASE_URL from env.

import postgres from "postgres";
import { classifyAsset } from "@/lib/classify/classify";
import { loadTaxonomyVectors } from "@/lib/classify/vectors";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const sql = postgres(dbUrl, { prepare: false });

  try {
    // Step 1: load taxonomy vectors. Exercises the 6e85410 fix path —
    // a regression manifests here as vectors with length=undefined (the
    // wrapped object shape) which collapses every cosine score to 0.
    const cache = await loadTaxonomyVectors();
    if (!cache) {
      console.error(
        "[verify-clip] FAIL — loadTaxonomyVectors() returned null " +
          "(plexo-vision unreachable or no disk cache)"
      );
      process.exit(1);
    }
    const topCount = cache.vectors.filter((v) => v.id.startsWith("top:")).length;
    const subCount = cache.vectors.filter((v) => v.id.startsWith("sub:")).length;
    console.log(
      `[verify-clip] taxonomy vectors loaded (${topCount} top-level, ${subCount} sub entries)`
    );

    // Step 2: find a candidate image asset.
    const assetIdArg = arg("asset");
    // postgres.js returns pgvector columns as the raw string "[0.1,0.2,...]".
    // Parse to number[] before passing to classifyAsset.
    type Row = { id: string; filename: string; clip_vec: string | number[] };
    let rows: Row[];

    if (typeof assetIdArg === "string") {
      rows = (await sql`
        SELECT id, filename, clip_vec
        FROM fonto.assets
        WHERE id = ${assetIdArg}::uuid
          AND clip_vec IS NOT NULL
          AND mime_type LIKE 'image/%'
        LIMIT 1
      `) as unknown as Row[];
      if (rows.length === 0) {
        throw new Error(`asset ${assetIdArg} not found or has no clip_vec`);
      }
    } else {
      rows = (await sql`
        SELECT id, filename, clip_vec
        FROM fonto.assets
        WHERE clip_vec IS NOT NULL
          AND mime_type LIKE 'image/%'
          AND lifecycle_state = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `) as unknown as Row[];
      if (rows.length === 0) {
        console.error(
          "[verify-clip] FAIL — no active image assets with clip_vec found; " +
            "run pnpm backfill:clip first"
        );
        process.exit(1);
      }
    }

    const { id, filename } = rows[0];
    const rawVec = rows[0].clip_vec;
    const clip_vec: number[] = Array.isArray(rawVec)
      ? rawVec
      : JSON.parse(String(rawVec));
    console.log(`[verify-clip] candidate: ${id} (${filename})`);

    // Step 3: classify. Override runner-up delta to 0 so borderline images
    // (top-1 and top-2 close in score) still pass as long as CLIP wins.
    // A genuine regression (all scores 0) still fails because the absolute
    // threshold check catches it first. The production pipeline keeps the
    // default 0.05 delta — this override is verify-only.
    process.env.CLASSIFY_RUNNER_UP_DELTA = "0";
    let result: Awaited<ReturnType<typeof classifyAsset>>;
    try {
      result = await classifyAsset(clip_vec, {
        classify: async () => {
          throw new Error(
            "CLIP confidence below threshold — fell through to LLM fallback"
          );
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verify-clip] FAIL — ${msg}`);
      console.error(`[verify-clip] asset: ${id} (${filename})`);
      process.exit(1);
    }

    // Step 4: assert.
    if (result.method !== "clip") {
      console.error(
        `[verify-clip] FAIL — classify_method=${result.method}, expected 'clip'`
      );
      process.exit(1);
    }

    console.log(
      `[verify-clip] PASS — classify_method=clip` +
        ` topLevel=${result.topLevel}` +
        ` confidence=${result.confidence.toFixed(4)}`
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[verify-clip] fatal:", err);
  process.exit(1);
});
