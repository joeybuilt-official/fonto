// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-shot — re-run CLASSIFICATION ONLY on every kind='moment' (or all-images)
// asset in a workspace using the existing clip_vec. NO re-CLIP, NO OCR,
// NO describe, NO face-detect, NO thumbnails. Pure DB update.
//
// Purpose: bulk-fix moments that were misclassified as 'photo' before the
// taxonomy + override tightening landed in main.
//
// Usage:
//   tsx scripts/classify-only-rerun.ts --workspace-id=<uuid> \
//     [--scope=moments-only|all-images] [--dry-run] [--limit=<n>]
//
// Scopes:
//   moments-only (default): kind='moment' AND classification='photo'
//   all-images            : every active image with a clip_vec
//
// Imports the SAME override helpers used by processAsset.ts — no behavior
// drift between fresh ingest + this backfill.

import postgres from "postgres";
import { classifyAsset } from "@/lib/classify/classify";
import { deriveKind } from "@/lib/classify/kind";
import {
  isScreenshot,
  hasRealCameraSignals,
  ocrLooksLikePaperDocument,
  isDocumentByOcr,
  type CameraEvidence,
} from "@/lib/processing/processAsset";
import {
  plexoAvailable,
  plexoEnsureWorkspace,
  plexoClassifyAsset,
} from "@/lib/plexo";

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
  filename: string;
  mime_type: string;
  classification: string | null;
  kind: string | null;
  clip_vec: number[] | null;
  width_px: number | null;
  height_px: number | null;
  camera_make: string | null;
  camera_model: string | null;
  exposure_time: string | null;
  f_number: number | null;
  iso: number | null;
  focal_length: number | null;
  lens_model: string | null;
  ocr_text: string | null;
}

interface DecisionResult {
  classification: string;
  subClassification: string | null;
  classifyMethod: "clip" | "llm-fallback" | null;
  classifyConfidence: number | null;
  kind: ReturnType<typeof deriveKind>;
}

async function decideForRow(
  row: Row,
  plexoWorkspaceId: string | null,
): Promise<DecisionResult> {
  const exif: CameraEvidence = {
    exposureTime: row.exposure_time,
    fNumber: row.f_number,
    iso: row.iso,
    focalLength: row.focal_length,
    lensModel: row.lens_model,
  };

  // 1. CLIP classify (LLM fallback only if CLIP is uncertain — same as live).
  const result = await classifyAsset(row.clip_vec, {
    classify: async () => {
      if (!plexoWorkspaceId) {
        // No Plexo workspace resolution available — degrade gracefully.
        return { topLevel: "photo" as const };
      }
      const topLevel = await plexoClassifyAsset(
        plexoWorkspaceId,
        row.filename,
        row.mime_type,
        row.ocr_text ?? undefined,
      );
      return { topLevel };
    },
  });

  let classification: string = result.topLevel;
  let subClassification: string | null = result.subLevel;
  const classifyMethodLabel: "clip" | "llm-fallback" = result.method;
  const classifyConfidence: number | null = result.confidence;

  // 2. Screenshot heuristic (filename + aspect).
  if (
    isScreenshot(row.filename, row.mime_type, row.width_px, row.height_px)
  ) {
    classification = "screenshot";
    subClassification = null;
  }
  const looksLikeCameraCapture = hasRealCameraSignals(exif);
  // 3. Restore: real camera capture overrides the screenshot heuristic.
  if (classification === "screenshot" && looksLikeCameraCapture) {
    classification = "photo";
    subClassification = null;
  }
  // 4. Positive-evidence demote: photo w/ no camera signals → screenshot.
  if (
    classification === "photo" &&
    !looksLikeCameraCapture &&
    row.mime_type.startsWith("image/")
  ) {
    classification = "screenshot";
    subClassification = null;
  }
  // 5. OCR-based document override (same as processAsset.ts post-OCR pass).
  if (
    row.mime_type.startsWith("image/") &&
    classification === "photo" &&
    (ocrLooksLikePaperDocument(row.ocr_text) || isDocumentByOcr(row.ocr_text))
  ) {
    classification = "document";
    subClassification = null;
  }
  // Also catch the OCR-paper-document case when classifier landed on "photo"
  // BEFORE the camera-evidence demote (i.e. phone shot of receipt). Mirror
  // the inline override in processAsset.ts ~line 353.
  if (
    row.mime_type.startsWith("image/") &&
    classification === "screenshot" &&
    ocrLooksLikePaperDocument(row.ocr_text)
  ) {
    // The inline pre-describe override only fires on "photo" or null —
    // mirror it here too: if OCR clearly says paper-doc, document beats
    // the demoted-screenshot bucket. Conservative: only fires when
    // ocrLooksLikePaperDocument is true (keyword/$money heuristic).
    classification = "document";
    subClassification = null;
  }

  const kind = deriveKind({
    mimeType: row.mime_type,
    classification,
    ...exif,
  });

  return {
    classification,
    subClassification,
    classifyMethod: classifyMethodLabel,
    classifyConfidence,
    kind,
  };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const workspaceId =
    typeof arg("workspace-id") === "string"
      ? (arg("workspace-id") as string)
      : null;
  if (!workspaceId) throw new Error("--workspace-id=<uuid> required");

  const scopeRaw = arg("scope");
  const scope: "moments-only" | "all-images" =
    scopeRaw === "all-images" ? "all-images" : "moments-only";
  const dryRun = !!arg("dry-run");
  const limitArg = arg("limit");
  const limit =
    typeof limitArg === "string"
      ? Number.parseInt(limitArg, 10)
      : Number.POSITIVE_INFINITY;
  const batchSize = 100;

  const sql = postgres(dbUrl, { prepare: false });

  console.log(
    `[classify-rerun] workspace=${workspaceId} scope=${scope} dryRun=${dryRun} limit=${limit === Number.POSITIVE_INFINITY ? "all" : limit}`,
  );

  // Resolve a Plexo workspace id once for the LLM fallback. If Plexo is
  // unavailable, classifyAsset's fallback will return "photo" by default —
  // which is fine, we won't write anything that wasn't already there.
  let plexoWorkspaceId: string | null = null;
  if (plexoAvailable()) {
    try {
      const [wsRow] = (await sql`
        SELECT u.id AS user_id, u.email AS email
        FROM fonto.workspaces w
        JOIN public."user" u ON u.id = w.user_id
        WHERE w.id = ${workspaceId}
      `) as Array<{ user_id: string; email: string | null }>;
      if (wsRow) {
        plexoWorkspaceId = await plexoEnsureWorkspace(
          wsRow.user_id,
          wsRow.email ?? undefined,
        );
        console.log(
          `[classify-rerun] plexo workspace resolved: ${plexoWorkspaceId}`,
        );
      }
    } catch (err) {
      console.warn("[classify-rerun] plexo workspace resolve failed:", err);
    }
  } else {
    console.log("[classify-rerun] plexo unavailable — CLIP-only path");
  }

  // Build the candidate query. clip_vec column is pgvector; postgres-js
  // returns it as the text repr "[...]". We parse it client-side.
  // Both scopes require: active, image mime, clip_vec NOT NULL, workspace match.
  const candidateRows = (
    scope === "moments-only"
      ? await sql`
          SELECT
            id,
            workspace_id,
            filename,
            mime_type,
            classification,
            kind,
            clip_vec::text AS clip_vec_text,
            width_px,
            height_px,
            camera_make,
            camera_model,
            exposure_time,
            f_number,
            iso,
            focal_length,
            lens_model,
            ocr_text
          FROM fonto.assets
          WHERE workspace_id = ${workspaceId}
            AND lifecycle_state = 'active'
            AND mime_type LIKE 'image/%'
            AND kind = 'moment'
            AND classification = 'photo'
            AND clip_vec IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ${limit === Number.POSITIVE_INFINITY ? 100_000_000 : limit}
        `
      : await sql`
          SELECT
            id,
            workspace_id,
            filename,
            mime_type,
            classification,
            kind,
            clip_vec::text AS clip_vec_text,
            width_px,
            height_px,
            camera_make,
            camera_model,
            exposure_time,
            f_number,
            iso,
            focal_length,
            lens_model,
            ocr_text
          FROM fonto.assets
          WHERE workspace_id = ${workspaceId}
            AND lifecycle_state = 'active'
            AND mime_type LIKE 'image/%'
            AND clip_vec IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ${limit === Number.POSITIVE_INFINITY ? 100_000_000 : limit}
        `
  ) as unknown as Array<Row & { clip_vec_text: string | null }>;

  console.log(`[classify-rerun] candidates: ${candidateRows.length}`);

  if (candidateRows.length === 0) {
    await sql.end({ timeout: 5 });
    return;
  }

  // Parse "[0.123, ...]" → number[] once per row.
  const rows: Row[] = candidateRows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    filename: r.filename,
    mime_type: r.mime_type,
    classification: r.classification,
    kind: r.kind,
    clip_vec: r.clip_vec_text ? parsePgVector(r.clip_vec_text) : null,
    width_px: r.width_px,
    height_px: r.height_px,
    camera_make: r.camera_make,
    camera_model: r.camera_model,
    exposure_time: r.exposure_time,
    f_number: r.f_number,
    iso: r.iso,
    focal_length: r.focal_length,
    lens_model: r.lens_model,
    ocr_text: r.ocr_text,
  }));

  const t0 = Date.now();
  let processed = 0;
  let changed = 0;
  let errors = 0;
  const kindHist: Record<string, number> = {};
  const classHist: Record<string, number> = {};

  try {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      // Process serially within the batch to keep Plexo authLimiter happy
      // and the log readable. CLIP-only path is in-memory + cheap so this
      // is still fast (no network per row when CLIP is decisive).
      for (const row of batch) {
        try {
          const decision = await decideForRow(row, plexoWorkspaceId);
          processed++;
          kindHist[decision.kind] = (kindHist[decision.kind] ?? 0) + 1;
          classHist[decision.classification] =
            (classHist[decision.classification] ?? 0) + 1;

          const classChanged =
            decision.classification !== row.classification ||
            decision.kind !== row.kind;
          if (classChanged) changed++;

          if (dryRun) {
            if (classChanged) {
              console.log(
                `  ${row.id} ${row.filename} | ` +
                  `class: ${row.classification ?? "null"} → ${decision.classification} | ` +
                  `kind: ${row.kind ?? "null"} → ${decision.kind} | ` +
                  `conf=${decision.classifyConfidence?.toFixed(3) ?? "n/a"} ` +
                  `method=${decision.classifyMethod ?? "n/a"}`,
              );
            }
          } else {
            await sql`
              UPDATE fonto.assets
              SET classification = ${decision.classification},
                  sub_classification = ${decision.subClassification},
                  classify_method = ${decision.classifyMethod},
                  classify_confidence = ${decision.classifyConfidence},
                  kind = ${decision.kind},
                  updated_at = now()
              WHERE id = ${row.id}
            `;
          }
        } catch (err) {
          errors++;
          console.warn(`  ERROR on ${row.id} ${row.filename}:`, err);
          // continue
        }
      }
      if ((i + batch.length) % 100 === 0 || i + batch.length >= rows.length) {
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[classify-rerun] progress: ${i + batch.length}/${rows.length} ` +
            `processed=${processed} changed=${changed} errors=${errors} ` +
            `elapsed=${elapsedSec}s | kind so far: ${JSON.stringify(kindHist)}`,
        );
      }
    }

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("\n[classify-rerun] DONE");
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

// pgvector text repr is "[0.123,0.456,...]" — split and parseFloat.
function parsePgVector(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return null;
  const parts = inner.split(",");
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number.parseFloat(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

main().catch((err) => {
  console.error("[classify-rerun] fatal:", err);
  process.exit(1);
});
