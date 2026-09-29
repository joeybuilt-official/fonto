// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — force the AI tier to RE-CLASSIFY
// a targeted bucket of "suspect" assets and re-derive their KIND.
//
// Purpose: CLIP mislabeled EXIF-stripped screenshots / graphics as "photo",
// which deriveKind then routed into kind='moment' (the Moments lens). This
// pulls each suspect through the app-owned AI tier — vision labels + OCR from
// the sidecar, then the completion tier (the owner's own connection) for an
// authoritative classification — then re-derives KIND so they leave Moments for
// Screenshots / Graphics / Documents.
//
// Unlike classify-only-rerun.ts (which re-runs the cheap CLIP-only path on the
// stored clip_vec), this script makes a real GPU vision call per asset. It is
// rate-limited via a small concurrency pool and resumable: completed rows are
// stamped classify_method='llm-vision-rerun', and the suspect query excludes
// that marker, so a re-run naturally skips done rows.
//
// Usage:
//   tsx scripts/reclassify-vision.ts --workspace-id=<uuid> \
//     [--dry-run] [--limit=<n>] [--concurrency=<n>]
//
// Mirrors processAsset.ts's unified-analyze path for the signed-URL derivation
// (previewKey ?? assetStorageKey), the analyzeImageUnified opts, and the
// classification → deriveKind mapping. Does NOT touch the legacy 5-call chain.
//
// SAFETY: hits the prod GPU vision model + writes to prod. Run --dry-run first.

import postgres from "postgres";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { intelligence } from "@/lib/intelligence/client";
import { classifyAssetWithAi } from "@/lib/intelligence/prompts";
import { deriveKind } from "@/lib/classify/kind";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

interface Row {
  id: string;
  workspace_id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  classification: string | null;
  kind: string | null;
  preview_key: string | null;
  width_px: number | null;
  height_px: number | null;
  exposure_time: string | null;
  f_number: number | null;
  iso: number | null;
  focal_length: number | null;
  lens_model: string | null;
  ocr_text: string | null;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  if (!intelligence.available("label") && !intelligence.available("complete")) {
    throw new Error(
      "no AI tier configured: set FONTO_VISION_URL (vision) and/or AI_BASE_URL/AI_API_KEY (completion)",
    );
  }

  const workspaceId =
    typeof arg("workspace-id") === "string"
      ? (arg("workspace-id") as string)
      : null;
  if (!workspaceId) throw new Error("--workspace-id=<uuid> required");

  const dryRun = !!arg("dry-run");
  const limitArg = arg("limit");
  const limit =
    typeof limitArg === "string"
      ? Number.parseInt(limitArg, 10)
      : Number.POSITIVE_INFINITY;
  const concurrencyArg = arg("concurrency");
  const concurrency =
    typeof concurrencyArg === "string"
      ? Math.max(1, Number.parseInt(concurrencyArg, 10))
      : 4;

  const sql = postgres(dbUrl, { prepare: false });

  console.log(
    `[reclassify-vision] workspace=${workspaceId} dryRun=${dryRun} ` +
      `concurrency=${concurrency} ` +
      `limit=${limit === Number.POSITIVE_INFINITY ? "all" : limit}`,
  );

  // Suspect bucket: active moments classified 'photo' by CLIP (or unknown
  // method) that carry NO camera EXIF — i.e. exactly the EXIF-stripped
  // screenshots/graphics CLIP confuses for real captures. classify_method
  // marker 'llm-vision-rerun' is excluded by the CLIP/NULL gate, so re-runs
  // skip already-processed rows (resumable).
  const rows = (await sql`
    SELECT
      id,
      workspace_id,
      w.user_id,
      filename,
      mime_type,
      classification,
      kind,
      preview_key,
      width_px,
      height_px,
      exposure_time,
      f_number,
      iso,
      focal_length,
      lens_model,
      ocr_text
    FROM fonto.assets a
    JOIN fonto.workspaces w ON w.id = a.workspace_id
    WHERE a.workspace_id = ${workspaceId}
      AND a.lifecycle_state = 'active'
      AND a.kind = 'moment'
      AND a.classification = 'photo'
      AND (a.classify_method IS NULL OR a.classify_method = 'clip')
      AND a.exif->>'FNumber' IS NULL
      AND a.exif->>'ISO' IS NULL
      AND a.exif->>'ExposureTime' IS NULL
      AND a.exif->>'FocalLength' IS NULL
      AND a.mime_type LIKE 'image/%'
      AND a.filename IS NOT NULL
    ORDER BY a.created_at DESC
    LIMIT ${limit === Number.POSITIVE_INFINITY ? 100_000_000 : limit}
  `) as unknown as Row[];

  console.log(`[reclassify-vision] suspects: ${rows.length}`);

  if (rows.length === 0) {
    await sql.end({ timeout: 5 });
    return;
  }

  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    await sql.end({ timeout: 5 });
    throw new Error("R2_BUCKET not set");
  }

  const t0 = Date.now();
  let processed = 0;
  let changed = 0;
  let errors = 0;
  const kindHist: Record<string, number> = {};
  const classHist: Record<string, number> = {};

  async function processRow(row: Row): Promise<void> {
    try {
      // Mirror processAsset.ts: feed the decoded preview to the VLM (it can't
      // decode HEIC/RAW originals); fall back to the original key only when no
      // preview derivative exists yet.
      const visionKey =
        row.preview_key ??
        assetStorageKey(row.workspace_id, row.id, row.filename);
      const signedUrl = await getSignedUrl(
        getS3Client(),
        new GetObjectCommand({ Bucket: bucket, Key: visionKey }),
        { expiresIn: 300 },
      );

      // Vision signals first: OCR (the sidecar fetches the URL itself) and
      // labels (fed the decoded preview bytes).
      const ocrFromVision = await intelligence
        .ocr({ imageUrl: signedUrl })
        .then((r) => r.spans.map((sp) => sp.text).join("\n"))
        .catch(() => null);
      let labels: string[] = [];
      try {
        const previewBytes = Buffer.from(
          await (await fetch(signedUrl)).arrayBuffer(),
        ).toString("base64");
        labels = (await intelligence.label(previewBytes)).labels.map((l) => l.label);
      } catch {
        // Labels are advisory; proceed with OCR + filename only.
      }

      // classifyConfidence/model stay 0/"ai" — the app-owned tier does not
      // return a calibrated score, and inventing one would be fiction.
      const classifyConfidence = 0;
      const classifyModel = "ai-tier";
      const classification = await classifyAssetWithAi(
        row.user_id,
        row.filename,
        row.mime_type,
        ocrFromVision ?? row.ocr_text ?? labels.join(", "),
      );
      const subClassification: string | null = null;
      // Only fill OCR when the row has none — never clobber existing OCR.
      const existingOcr =
        row.ocr_text && row.ocr_text.length > 0 ? row.ocr_text : null;
      const ocrToPersist = existingOcr ?? ocrFromVision ?? null;
      // deriveKind reads the OCR we'll actually store.
      const ocrForKind = existingOcr ?? ocrFromVision ?? null;

      const newKind = deriveKind({
        mimeType: row.mime_type,
        classification,
        filename: row.filename,
        exposureTime: row.exposure_time,
        fNumber: row.f_number,
        iso: row.iso,
        focalLength: row.focal_length,
        lensModel: row.lens_model,
        widthPx: row.width_px,
        heightPx: row.height_px,
        subClassification,
        ocrText: ocrForKind,
      });

      processed++;
      kindHist[newKind] = (kindHist[newKind] ?? 0) + 1;
      classHist[classification] = (classHist[classification] ?? 0) + 1;

      const didChange =
        classification !== row.classification || newKind !== row.kind;
      if (didChange) changed++;

      if (dryRun) {
        if (didChange) {
          console.log(
            `  ${row.id} ${row.filename} | ` +
              `class: ${row.classification ?? "null"} → ${classification} | ` +
              `kind: ${row.kind ?? "null"} → ${newKind} | ` +
              `model=${classifyModel}`,
          );
        }
      } else {
        await sql`
          UPDATE fonto.assets
          SET classification = ${classification},
              sub_classification = ${subClassification},
              kind = ${newKind},
              classify_method = 'llm-vision-rerun',
              classify_confidence = ${classifyConfidence},
              ocr_text = ${ocrToPersist},
              updated_at = now()
          WHERE id = ${row.id}
        `;
      }
    } catch (err) {
      // Leave the row UNCHANGED (no marker) so it retries on the next run.
      errors++;
      console.warn(`  ERROR on ${row.id} ${row.filename}:`, err);
    }
  }

  // Concurrency pool: keep `concurrency` vision calls in flight at once. Each
  // call hits the GPU vision model (~seconds), so a fixed-width worker pool
  // bounds GPU pressure while still draining the backlog.
  let cursor = 0;
  let lastLogged = 0;
  async function worker(): Promise<void> {
    while (cursor < rows.length) {
      const idx = cursor++;
      await processRow(rows[idx]);
      const done = processed + errors;
      if (done - lastLogged >= 100 || done === rows.length) {
        lastLogged = done;
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[reclassify-vision] progress: ${done}/${rows.length} ` +
            `processed=${processed} changed=${changed} errors=${errors} ` +
            `elapsed=${elapsedSec}s | kind so far: ${JSON.stringify(kindHist)}`,
        );
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, () =>
        worker(),
      ),
    );

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("\n[reclassify-vision] DONE");
    console.log(`  processed:  ${processed}`);
    console.log(`  changed:    ${changed}`);
    console.log(`  errors:     ${errors}`);
    console.log(`  dryRun:     ${dryRun}`);
    console.log(`  elapsed:    ${elapsedSec}s`);
    console.log(`  kind dist:  ${JSON.stringify(kindHist)}`);
    console.log(`  class dist: ${JSON.stringify(classHist)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[reclassify-vision] fatal:", err);
    process.exit(1);
  });
