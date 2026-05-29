// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Asset processing pipeline (classification, description, OCR, tags,
// memory.write, event emit). Lives in `lib/processing/` so both the Next.js
// app and the worker process can call it without depending on each other.
//
// Previously this lived inside `app/api/v1/assets/route.ts` as a
// fire-and-forget function — see Phase 0 plan item 0.1. It is now invoked
// from the BullMQ worker; the API route just enqueues a job.

import { eq, and } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db, schema } from "@/lib/db";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import {
  plexoAvailable,
  plexoEnsureWorkspace,
  plexoClassifyAsset,
  classifyTextCodeByMime,
  plexoDescribeImage,
  plexoDescribeDocument,
  plexoPublishEvent,
  plexoStoreMemory,
  plexoSuggestTags,
  plexoVisionOcr,
} from "@/lib/plexo";
import { assetProcessingDurationSeconds } from "@/lib/metrics";
import { emitWebhook } from "@/lib/webhooks/emit";
import { classifyAsset } from "@/lib/classify/classify";
import { extractDocumentText } from "@/lib/processing/extractDocumentText";
import { labelImageUrl, visionConfigured } from "@/lib/plexo-vision";

const DOCUMENT_CLASSIFICATIONS = new Set([
  "document",
  "receipt",
  "scan",
  "report",
  "form",
  "contract",
  "letter",
]);
const DOCUMENT_TRIGGER_MIME = ["application/pdf", "text/", "image/tiff"];

// Screenshots were being mislabeled as documents/scans by the classifier.
// Detect them deterministically: a filename that mentions "screenshot", or a
// PNG whose aspect ratio matches a phone-portrait (~9:16–9:21) or desktop 16:9
// display. When matched we force classification to "screenshot".
const SCREENSHOT_NAME_RE = /screenshot|screen.?shot/i;
function isScreenshot(
  filename: string,
  mimeType: string,
  widthPx: number | null,
  heightPx: number | null,
): boolean {
  if (SCREENSHOT_NAME_RE.test(filename)) return true;
  if (mimeType === "image/png" && widthPx && heightPx) {
    const ar = widthPx / heightPx;
    const portraitScreen = ar >= 0.42 && ar <= 0.66; // tall phone
    const landscapeScreen = ar >= 1.7 && ar <= 1.85; // 16:9 desktop
    return portraitScreen || landscapeScreen;
  }
  return false;
}

export interface ProcessAssetParams {
  assetId: string;
  userId: string;
  email?: string;
  filename: string;
  mimeType: string;
  extractedText: string | null;
}

/**
 * Full post-upload processing pipeline. Throws on unrecoverable errors so the
 * BullMQ worker can record an attempt and retry per the queue's backoff
 * policy. Recoverable sub-steps (OCR, tag suggestion, memory write) still
 * swallow their own errors — those aren't worth retrying the whole job over.
 */
export async function processAsset(params: ProcessAssetParams): Promise<void> {
  const endTimer = assetProcessingDurationSeconds.startTimer();
  // Phase 4.6 — populated mid-pipeline so the timer can record which classify
  // path we took (clip / llm-fallback / skip for non-image).
  const ctx: { classifyMethod: "clip" | "llm-fallback" | "skip" } = {
    classifyMethod: "skip",
  };
  try {
    await processAssetInner(params, ctx);
    endTimer({ outcome: "success", classify_method: ctx.classifyMethod });
  } catch (err) {
    endTimer({ outcome: "failure", classify_method: ctx.classifyMethod });
    throw err;
  }
}

async function processAssetInner(
  params: ProcessAssetParams,
  ctx: { classifyMethod: "clip" | "llm-fallback" | "skip" },
): Promise<void> {
  const { assetId, userId, email, filename, mimeType, extractedText } = params;

  await db
    .update(schema.assets)
    .set({ processingState: "classified" })
    .where(eq(schema.assets.id, assetId));

  let classification: string;
  let subClassification: string | null = null;
  let classifyMethodLabel: "clip" | "llm-fallback" | null = null;
  let classifyConfidence: number | null = null;
  let clipSuggestedTags: string[] = [];
  let description: string | null = null;
  let plexoWorkspaceId: string | null = null;
  // Phase 6.x — document text (PDF text layer / OCR / plain text), extracted
  // in the non-image branch below and persisted as ocr_text further down.
  let docText: string | null = null;
  let docOcrState: "ready" | "empty" | null = null;

  if (plexoAvailable()) {
    plexoWorkspaceId = await plexoEnsureWorkspace(userId, email);

    if (mimeType.startsWith("image/")) {
      // Phase 4.6 — try zero-shot CLIP first; fall back to vision-LLM
      // classification if confidence is too low (or CLIP is unavailable).
      const clipVec = await waitForClipVec(assetId);
      const workspaceIdForLlm = plexoWorkspaceId;
      const result = await classifyAsset(clipVec, {
        classify: async () => {
          const topLevel = await plexoClassifyAsset(
            workspaceIdForLlm,
            filename,
            mimeType,
            extractedText ?? undefined,
          );
          // Tag suggestions are produced downstream once we have a
          // `description`; nothing to attach here.
          return { topLevel };
        },
      });
      classification = result.topLevel;
      subClassification = result.subLevel;
      classifyMethodLabel = result.method;
      classifyConfidence = result.confidence;
      clipSuggestedTags = result.suggestedTags;
      ctx.classifyMethod = result.method;

      // Force screenshots — the classifier otherwise tends to file text-heavy
      // screenshots as documents/scans.
      const [dims] = await db
        .select({ widthPx: schema.assets.widthPx, heightPx: schema.assets.heightPx })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (isScreenshot(filename, mimeType, dims?.widthPx ?? null, dims?.heightPx ?? null)) {
        classification = "screenshot";
        subClassification = null;
      }

      description = await plexoDescribeImage(plexoWorkspaceId, filename, mimeType);
    } else if (mimeType.startsWith("video/")) {
      // Phase 8a — video classification is deterministic by mime, no
      // round-trip to Plexo. (A future revision could ask Plexo to
      // describe the keyframe; for v1 the filename is enough metadata.)
      classification = "video";
      classifyMethodLabel = "llm-fallback";
      ctx.classifyMethod = "llm-fallback";
    } else {
      // Non-image, non-video (documents). Extract the text layer first so
      // both classification and description are grounded in real content.
      const [docRow] = await db
        .select({
          workspaceId: schema.assets.workspaceId,
          previewKey: schema.assets.previewKey,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      if (docRow) {
        const extracted = await extractDocumentText({
          workspaceId: docRow.workspaceId,
          assetId,
          filename,
          mimeType,
          previewKey: docRow.previewKey,
        }).catch((err) => {
          console.warn("[fonto] doc text extraction failed for", assetId, err);
          return { text: "", method: "none" as const };
        });
        docText = extracted.text || null;
        docOcrState = docText ? "ready" : "empty";
      }

      const textCode = classifyTextCodeByMime(mimeType);
      if (textCode) {
        classification = textCode;
        classifyMethodLabel = null;
        ctx.classifyMethod = "skip";
      } else {
        classification = await plexoClassifyAsset(
          plexoWorkspaceId,
          filename,
          mimeType,
          docText ?? extractedText ?? undefined,
        );
        classifyMethodLabel = "llm-fallback";
        ctx.classifyMethod = "llm-fallback";
      }

      description = await plexoDescribeDocument(
        plexoWorkspaceId,
        filename,
        mimeType,
        docText ?? "",
      ).catch((err) => {
        console.warn("[fonto] doc description failed for", assetId, err);
        return null;
      });
    }
  } else {
    classification = mimeType.startsWith("image/")
      ? "photo"
      : mimeType.startsWith("video/")
        ? "video"
        : "document";
  }

  await db
    .update(schema.assets)
    .set({
      processingState: "extracted",
      classification,
      description,
      subClassification,
      classifyMethod: classifyMethodLabel,
      classifyConfidence,
    })
    .where(eq(schema.assets.id, assetId));

  await db
    .update(schema.assets)
    .set({ processingState: "ready" })
    .where(eq(schema.assets.id, assetId));

  // ── Text layer / OCR. Images hit the vision OCR path; documents persist
  // the text extracted above; anything else is marked skipped. All failures
  // are non-fatal — recorded via ocrState.
  if (plexoWorkspaceId && mimeType.startsWith("image/")) {
    await runOcrForAsset(assetId, plexoWorkspaceId).catch((err) => {
      console.warn("[fonto] OCR failed for asset", assetId, err);
    });
  } else if (docOcrState !== null) {
    await db
      .update(schema.assets)
      .set({ ocrText: docText, ocrState: docOcrState })
      .where(eq(schema.assets.id, assetId));
  } else if (!mimeType.startsWith("image/")) {
    await db
      .update(schema.assets)
      .set({ ocrState: "skipped" })
      .where(eq(schema.assets.id, assetId));
  }

  const assetPayload = {
    assetId,
    filename,
    mimeType,
    classification,
    description,
  };

  void plexoPublishEvent("ext.fonto.asset.processed", assetPayload);

  // Phase 2.4 — outbound webhook (asset.processed). We look up workspaceId
  // here rather than threading it through ProcessAssetParams to keep this
  // edit additive vs. parallel worktrees that touch the same param shape.
  try {
    const [row] = await db
      .select({ workspaceId: schema.assets.workspaceId })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1);
    if (row) {
      await emitWebhook(row.workspaceId, "asset.processed", {
        assetId,
        workspaceId: row.workspaceId,
        filename,
        mimeType,
        classification: classification ?? null,
        description: description ?? null,
        processedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn("[fonto-webhooks] asset.processed emit failed:", err);
  }

  const isDocClassification = DOCUMENT_CLASSIFICATIONS.has(classification);
  const isDocMime = DOCUMENT_TRIGGER_MIME.some((p) => mimeType.startsWith(p));
  if (isDocClassification || isDocMime) {
    void plexoPublishEvent("ext.fonto.document.processed", assetPayload);
  }

  const effectiveText = extractedText ?? docText;

  if (classification === "receipt") {
    void plexoPublishEvent("ext.fonto.receipt.detected", {
      ...assetPayload,
      extractedText: effectiveText?.slice(0, 500) ?? null,
    });
  }

  if (plexoWorkspaceId) {
    const memContent = [
      `[Fonto asset] ${filename}`,
      `Type: ${mimeType} | Classification: ${classification}`,
      description ? `Description: ${description}` : null,
      effectiveText ? `Content: ${effectiveText.slice(0, 800)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    void plexoStoreMemory(plexoWorkspaceId, memContent, {
      source: "fonto",
      assetId,
      classification,
      mimeType,
    });

    const llmTags = await plexoSuggestTags(
      plexoWorkspaceId,
      filename,
      classification,
      description
    );
    const [asset] = await db
      .select({ workspaceId: schema.assets.workspaceId })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1);

    // Phase 4.x — object/scene "things" labels for images, from the vision
    // sidecar's VLM. Folded into the same AI-tag path as CLIP/LLM tags.
    let visionLabels: string[] = [];
    if (asset && mimeType.startsWith("image/") && visionConfigured()) {
      try {
        const signedUrl = await getSignedUrl(
          getS3Client(),
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET!,
            Key: assetStorageKey(asset.workspaceId, assetId, filename),
          }),
          { expiresIn: 300 }
        );
        visionLabels = (await labelImageUrl(signedUrl)).labels;
      } catch (err) {
        console.warn("[fonto] vision labels failed for", assetId, err);
      }
    }

    // Phase 4.6 — fold in zero-shot CLIP tag suggestions when CLIP was the
    // chosen classifier. Dedupe case-insensitively but preserve the CLIP
    // names' original casing (taxonomy curates these to be display-ready,
    // e.g. "Portraits" not "portraits").
    const seen = new Set<string>();
    const suggestedNames: string[] = [];
    for (const name of [...clipSuggestedTags, ...llmTags, ...visionLabels]) {
      const key = name.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      suggestedNames.push(name);
    }

    if (asset && suggestedNames.length > 0) {
      for (const name of suggestedNames) {
        const existing = await db
          .select({ id: schema.tags.id })
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.workspaceId, asset.workspaceId),
              eq(schema.tags.name, name)
            )
          )
          .limit(1);

        let tagId: string;
        if (existing[0]) {
          tagId = existing[0].id;
        } else {
          const [newTag] = await db
            .insert(schema.tags)
            .values({
              workspaceId: asset.workspaceId,
              name,
              aiSuggested: true,
            })
            .returning({ id: schema.tags.id });
          tagId = newTag.id;
        }

        // asset_tags has no unique (asset_id, tag_id) index, so
        // onConflictDoNothing can't dedupe — guard explicitly so a
        // re-process (e.g. label backfill) doesn't double-link a tag.
        const existingLink = await db
          .select({ assetId: schema.assetTags.assetId })
          .from(schema.assetTags)
          .where(
            and(
              eq(schema.assetTags.assetId, assetId),
              eq(schema.assetTags.tagId, tagId)
            )
          )
          .limit(1);
        if (!existingLink[0]) {
          await db.insert(schema.assetTags).values({ assetId, tagId });
        }
      }
      // Phase 4.6 — stamp `auto_tagged_at` whenever a tag pass actually ran.
      // A future re-tagging cron can find never-tagged rows with
      // `WHERE auto_tagged_at IS NULL` once the taxonomy expands.
      await db
        .update(schema.assets)
        .set({ autoTaggedAt: new Date() })
        .where(eq(schema.assets.id, assetId));
    }
  }
}

/**
 * Phase 4.6 — short-poll for `clip_vec` to land on an asset row. The CLIP
 * embedding is produced by the Phase 4.2 worker, which may race with this
 * pipeline. Cap the wait at ~3s; if it doesn't show up by then we let
 * `classifyAsset` see a null vec and fall back to the LLM classifier.
 *
 * Returns `null` if:
 *   - the column doesn't exist yet (4.2 hasn't landed) — DB returns a
 *     property-missing error which we swallow,
 *   - the timeout elapses,
 *   - the embedding worker explicitly stored a zero-length vector.
 */
async function waitForClipVec(assetId: string): Promise<number[] | null> {
  const deadline = Date.now() + 3000;
  const interval = 250;
  while (Date.now() < deadline) {
    try {
      // TODO(4.2): once `assets.clip_vec` is part of the schema we can use
      // the typed column selector. Until then, fall back to a raw select
      // that doesn't fail if the column is missing.
      const rows = (await db.execute(
        (await import("drizzle-orm")).sql`select clip_vec from fonto.assets where id = ${assetId}::uuid limit 1`,
      )) as unknown as { rows?: Array<{ clip_vec?: number[] | null }> };
      const vec = rows.rows?.[0]?.clip_vec;
      if (Array.isArray(vec) && vec.length > 0) {
        return vec;
      }
    } catch {
      // Column doesn't exist (pre-4.2) — give up immediately.
      return null;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

/**
 * Run OCR on an image asset via Plexo's vision endpoint and persist the
 * result. Marks the asset's `ocrState` accordingly. Used both inline (after
 * upload, via the worker's processAsset) and by the nightly backfill cron.
 */
export async function runOcrForAsset(
  assetId: string,
  plexoWorkspaceId: string
): Promise<void> {
  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);
  if (!asset) return;
  if (!asset.mimeType.startsWith("image/")) {
    await db
      .update(schema.assets)
      .set({ ocrState: "skipped" })
      .where(eq(schema.assets.id, assetId));
    return;
  }

  const bucket = process.env.R2_BUCKET!;
  const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  let signedUrl: string;
  try {
    signedUrl = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 300 }
    );
  } catch (err) {
    console.warn("[fonto] OCR presign failed for asset", assetId, err);
    await db
      .update(schema.assets)
      .set({ ocrState: "failed" })
      .where(eq(schema.assets.id, assetId));
    return;
  }

  // Phase 4.4 — observe the OCR step with the shared processing-duration
  // histogram. Labels: paddle | llm-fallback | empty | skip | failure.
  // This is in addition to the per-pipeline observation in `processAsset`,
  // and is the only place that records the OCR sub-step (used both inline
  // by the worker and by the nightly backfill cron).
  const endTimer = assetProcessingDurationSeconds.startTimer();
  let result: Awaited<ReturnType<typeof plexoVisionOcr>>;
  try {
    result = await plexoVisionOcr(plexoWorkspaceId, signedUrl);
  } catch (err) {
    endTimer({ outcome: "failure" });
    console.warn("[fonto] OCR failed for asset", assetId, err);
    await db
      .update(schema.assets)
      .set({ ocrState: "failed" })
      .where(eq(schema.assets.id, assetId));
    return;
  }

  if (!result) {
    // Neither path was attempted (vision unavailable, fallback disabled).
    endTimer({ outcome: "skip" });
    await db
      .update(schema.assets)
      .set({ ocrState: "failed" })
      .where(eq(schema.assets.id, assetId));
    return;
  }

  // Distinguish "ran but no text" from "ran and got text". Phase 4.4:
  // PaddleOCR happily returns an empty result for solid-colour photos /
  // abstract art — that's not a failure.
  const hadText = result.text.length > 0;
  // `lines: []` + non-empty text => the legacy LLM fallback path produced
  // this result. Useful for grafana labelling so you can see how often the
  // fallback fires.
  const usedFallback = hadText && result.lines.length === 0;
  endTimer({
    outcome: hadText
      ? usedFallback
        ? "llm-fallback"
        : "paddle"
      : "empty",
  });

  await db
    .update(schema.assets)
    .set({
      ocrText: result.text,
      ocrState: hadText ? "ready" : "empty",
      // Per-line boxes only meaningful when PaddleOCR ran. The LLM
      // fallback path returns `lines: []`.
      ocrBoxes: result.lines.length > 0 ? result.lines : null,
    })
    .where(eq(schema.assets.id, assetId));

  if (hadText) {
    void plexoPublishEvent("ext.fonto.asset.ocr_extracted", {
      assetId,
      filename: asset.filename,
      textLength: result.text.length,
      model: result.model,
      lineCount: result.lines.length,
    });
  }
}
