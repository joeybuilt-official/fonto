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

import { eq, and, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
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
import {
  analyzeImageUnified,
  unifiedAnalyzeEnabled,
  type AnalyzeImageResult,
} from "@/lib/plexo-analyze";
import { assetProcessingDurationSeconds } from "@/lib/metrics";
import { emitWebhook } from "@/lib/webhooks/emit";
import { classifyAsset } from "@/lib/classify/classify";
import { deriveKind } from "@/lib/classify/kind";
import { tryEnqueueFaceDetect } from "@/lib/assets/createAssetRow";
import { extractDocumentText } from "@/lib/processing/extractDocumentText";
import { labelImageUrl, visionConfigured } from "@/lib/plexo-vision";
import { isJunkLabel } from "@/lib/processing/labelStoplist";

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

// Override helpers (isScreenshot, hasRealCameraSignals, isDocumentByOcr,
// ocrLooksLikePaperDocument, CameraEvidence) live in classifyHelpers.ts so
// the one-shot classify-only-rerun script can import them without dragging
// in the Plexo SDK + sharp + S3 client + webhook stack that this file
// pulls at top-level. Re-exported here so existing import sites keep working.
export {
  isScreenshot,
  hasRealCameraSignals,
  isDocumentByOcr,
  ocrLooksLikePaperDocument,
  looksLikeCameraPhoto,
  type CameraEvidence,
} from "./classifyHelpers";
import {
  isScreenshotByName,
  isScreenshotByAspect,
  isDocumentByOcr,
  ocrLooksLikePaperDocument,
  looksLikeCameraPhoto,
  type CameraEvidence,
} from "./classifyHelpers";

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
  // Phase 7.1 — real-camera-capture signals shared between the screenshot
  // override (inside the image branch) and the deriveKind call below.
  // Hoisted to function scope so we only read the row once.
  let cameraEvidence: CameraEvidence = {};
  // Phase 7.2 — OCR text from inside the image branch, hoisted so the
  // document-via-OCR override can re-evaluate classification after OCR
  // runs (CLIP/LLM often misses phone photos of receipts because the
  // hand + table backdrop pulls the classifier toward "photo").
  let imageOcrText: string | null = null;
  // ADR 0002 — unified analyze-image result, hoisted so the suggested-tags
  // block at the end can use the unified call's tags instead of an extra
  // plexoSuggestTags round-trip. null when the unified path didn't run
  // (flag off OR non-image OR the unified call failed mid-flight).
  let unifiedResultTopLevel: AnalyzeImageResult | null = null;

  if (plexoAvailable()) {
    plexoWorkspaceId = await plexoEnsureWorkspace(userId, email);

    if (mimeType.startsWith("image/")) {
      // Phase 4.6 — try zero-shot CLIP first; fall back to vision-LLM
      // classification if confidence is too low (or CLIP is unavailable).
      const clipVec = await waitForClipVec(assetId);

      // Read EXIF + dimensions row ONCE upfront — needed for both the
      // legacy and unified paths (camera-evidence + hints + screenshot
      // override).
      const [dims] = await db
        .select({
          widthPx: schema.assets.widthPx,
          heightPx: schema.assets.heightPx,
          cameraMake: schema.assets.cameraMake,
          cameraModel: schema.assets.cameraModel,
          exposureTime: schema.assets.exposureTime,
          fNumber: schema.assets.fNumber,
          iso: schema.assets.iso,
          focalLength: schema.assets.focalLength,
          lensModel: schema.assets.lensModel,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1);
      cameraEvidence = {
        exposureTime: dims?.exposureTime ?? null,
        fNumber: dims?.fNumber ?? null,
        iso: dims?.iso ?? null,
        focalLength: dims?.focalLength ?? null,
        lensModel: dims?.lensModel ?? null,
      };
      const looksLikeCameraCapture = looksLikeCameraPhoto(filename, mimeType, cameraEvidence);

      // ADR 0002 — unified analyze-image path. ONE multimodal call replaces
      // the legacy chain (classify-LLM-fallback + label + OCR + describe +
      // suggest-tags). Gated by USE_UNIFIED_ANALYZE so the rollout is a
      // pure env-flag flip — no code redeploy needed to roll back.
      //
      // CLIP still runs first; it produces the curated `clipSuggestedTags`
      // from the taxonomy AND a soft hint for the unified call. The unified
      // call's classification overrides CLIP's when CLIP confidence is low
      // (matching the legacy LLM-fallback behaviour), and gets the final
      // word on subClassification + description + OCR + labels + tags.
      let preDescribeLabels: string[] = [];
      let preDescribeOcrText: string | null = null;
      // Local alias for the hoisted function-scope variable. Assigning
      // through this alias keeps the existing in-block reads readable
      // while making the result visible to the suggested-tags block at
      // the bottom of the pipeline.
      let unifiedResult: AnalyzeImageResult | null = null;
      const useUnified = unifiedAnalyzeEnabled();

      // CLIP-only classify pass (no LLM fallback when unified is on — the
      // unified call itself IS our LLM fallback, with vision context).
      const workspaceIdForLlm = plexoWorkspaceId;
      const clipResult = await classifyAsset(clipVec, {
        classify: async () => {
          if (useUnified) {
            // Defer LLM classification to the unified call below. Return
            // a placeholder so classifyAsset records method=llm-fallback;
            // we'll overwrite classification + subClassification from the
            // unified result before downstream heuristics run.
            return { topLevel: "photo" };
          }
          const topLevel = await plexoClassifyAsset(
            workspaceIdForLlm,
            filename,
            mimeType,
            extractedText ?? undefined,
          );
          return { topLevel };
        },
      });
      classification = clipResult.topLevel;
      subClassification = clipResult.subLevel;
      classifyMethodLabel = clipResult.method;
      classifyConfidence = clipResult.confidence;
      clipSuggestedTags = clipResult.suggestedTags;
      ctx.classifyMethod = clipResult.method;

      if (useUnified) {
        // Sign the preview URL once and call the unified endpoint. Mirrors
        // the legacy `visionKey` derivation so HEIC/RAW originals route via
        // the decoded preview (the VLM can't decode them).
        try {
          const [imgRow] = await db
            .select({
              workspaceId: schema.assets.workspaceId,
              previewKey: schema.assets.previewKey,
            })
            .from(schema.assets)
            .where(eq(schema.assets.id, assetId))
            .limit(1);
          if (imgRow) {
            const visionKey =
              imgRow.previewKey ??
              assetStorageKey(imgRow.workspaceId, assetId, filename);
            const signedUrl = await storage().presignGet(visionKey, { expiresIn: 300 });
            const unifiedStartedAt = Date.now();
            unifiedResult = await analyzeImageUnified({
              workspaceId: plexoWorkspaceId,
              imageUrl: signedUrl,
              mimeType,
              filename,
              hints: {
                topClipClass: clipResult.method === "clip" ? clipResult.taxonomyTopKey : undefined,
                clipConfidence: clipResult.confidence,
                cameraMake: dims?.cameraMake ?? undefined,
                hasExposureExif:
                  cameraEvidence.exposureTime != null ||
                  cameraEvidence.fNumber != null ||
                  cameraEvidence.iso != null ||
                  cameraEvidence.focalLength != null,
                widthPx: dims?.widthPx ?? undefined,
                heightPx: dims?.heightPx ?? undefined,
              },
            });
            console.log(
              `[fonto] analyzeImage timing assetId=${assetId} unified=1 model=${unifiedResult.model} latencyMs=${Date.now() - unifiedStartedAt} serverLatencyMs=${unifiedResult.latencyMs}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Any Plexo HTTP response error is permanent for THIS image: retrying will
          // reproduce the same MODEL_PARSE_ERROR / INTERNAL_ERROR / 4xx / 5xx. We
          // must NOT keep the row stuck at 'captured' — CLIP fallback + defaults
          // still drive it to 'ready' so the "Processing N items" counter drains.
          // Pure network failures (fetch failed / ECONNREFUSED / socket closed) do
          // NOT start with "plexo analyze-image HTTP" — rethrow those so BullMQ
          // retries when Plexo is back up.
          if (msg.startsWith("plexo analyze-image HTTP")) {
            console.warn("[fonto] analyze-image response error — skipping unified for", assetId, msg);
          } else {
            console.warn("[fonto] unified analyze-image transport failed for", assetId, err);
            throw err;
          }
        }
      }

      if (unifiedResult) {
        // Map unified → existing variables that the downstream heuristics
        // and DB writes consume. CLIP's classification only wins when the
        // CLIP path was decisive (method='clip'); otherwise the unified
        // model's classification + sub-class wins (matches the legacy
        // LLM-fallback path's authority).
        if (clipResult.method === "llm-fallback") {
          classification = unifiedResult.classification;
          subClassification = unifiedResult.subClassification;
          classifyMethodLabel = "llm-fallback";
        }
        preDescribeLabels = unifiedResult.labels;
        preDescribeOcrText = unifiedResult.ocrText;
        imageOcrText = unifiedResult.ocrText;
        description = unifiedResult.description;

        // Persist OCR text to the DB right here so the downstream document-
        // override + deriveKind read the same string. Mirrors what
        // runOcrForAsset() writes; we just skip the per-line bbox column
        // because the unified VLM doesn't return boxes.
        const hadOcrText = (unifiedResult.ocrText ?? "").length > 0;
        await db
          .update(schema.assets)
          .set({
            ocrText: unifiedResult.ocrText ?? null,
            ocrState: hadOcrText ? "ready" : "empty",
            ocrBoxes: null,
          })
          .where(eq(schema.assets.id, assetId));
        if (hadOcrText) {
          void plexoPublishEvent("ext.fonto.asset.ocr_extracted", {
            assetId,
            filename,
            textLength: unifiedResult.ocrText!.length,
            model: unifiedResult.model,
            lineCount: 0,
          });
        }
        // Hoist into function scope so the suggested-tags block below
        // skips the extra plexoSuggestTags call.
        unifiedResultTopLevel = unifiedResult;
      } else {
        // Legacy chain — flag off OR unified call failed mid-flight.
        // Image-grounded signals BEFORE description so the caption can quote
        // real OCR text and reference the objects/scene the vision model saw.
        if (visionConfigured()) {
          try {
            const [imgRow] = await db
              .select({
                workspaceId: schema.assets.workspaceId,
                previewKey: schema.assets.previewKey,
              })
              .from(schema.assets)
              .where(eq(schema.assets.id, assetId))
              .limit(1);
            if (imgRow) {
              // Feed the vision model the decoded preview (sharp/libheif webp),
              // not the original. The VLM can't decode HEIC/RAW, so handing it
              // the raw original makes it confabulate a generic scene — which is
              // exactly how Drive-imported HEIC photos all got tagged
              // sunset/golden-hour. Falls back to the original only when the
              // preview derivative isn't ready yet (thumbnail job races this one);
              // a reprocess pass then picks up the now-present preview.
              const visionKey =
                imgRow.previewKey ??
                assetStorageKey(imgRow.workspaceId, assetId, filename);
              const signedUrl = await storage().presignGet(visionKey, { expiresIn: 300 });
              preDescribeLabels = (await labelImageUrl(signedUrl)).labels;
            }
          } catch (err) {
            console.warn("[fonto] pre-describe labels failed for", assetId, err);
          }
        }
        // OCR runs before describe too — receipt totals, sign text, slide
        // headings, etc. become grounded inputs to the caption prompt instead
        // of being persisted after the caption is already wrong.
        await runOcrForAsset(assetId, plexoWorkspaceId).catch((err) => {
          console.warn("[fonto] OCR (pre-describe) failed for asset", assetId, err);
        });
        const [ocrRow] = await db
          .select({ ocrText: schema.assets.ocrText })
          .from(schema.assets)
          .where(eq(schema.assets.id, assetId))
          .limit(1);
        preDescribeOcrText = ocrRow?.ocrText ?? null;
        imageOcrText = preDescribeOcrText;

        description = await plexoDescribeImage(
          plexoWorkspaceId,
          filename,
          mimeType,
          {
            classification,
            labels: preDescribeLabels,
            ocrText: preDescribeOcrText,
          }
        );
      }

      // Force screenshots — the classifier otherwise tends to file text-heavy
      // screenshots as documents/scans. Runs AFTER the LLM (legacy or
      // unified) so the heuristic always has the final word.
      //
      // Spec 2026-06-10: the FILENAME signal ("Screenshot...") is trusted and
      // always wins. The aspect-ratio-only signal (shape ≠ content) must NOT
      // override a real-scene classification the vision model already gave
      // (photo/portrait/event/selfie/landscape/etc.) — an EXIF-stripped tall
      // photo is still a photo. Only let AR set screenshot when the model
      // produced no usable classification.
      if (isScreenshotByName(filename)) {
        classification = "screenshot";
        subClassification = null;
      } else if (
        (!classification || classification === "") &&
        isScreenshotByAspect(mimeType, dims?.widthPx ?? null, dims?.heightPx ?? null)
      ) {
        classification = "screenshot";
        subClassification = null;
      }
      // A genuine real-camera capture carries exposure / aperture / ISO / lens
      // metadata. iOS + Android STAMP cameraMake on screenshots too ("Apple",
      // "Google", "Samsung"), so cameraMake alone is not enough — the prior
      // override on `dims?.cameraMake` flipped every phone screenshot back to
      // "photo" and flooded Moments. Require a real shooting parameter.
      if (classification === "screenshot" && looksLikeCameraCapture) {
        classification = "photo";
        subClassification = null;
      }

      // Phase 7.2 — OCR-based document override. Phone-photographed
      // receipts / packing slips / invoices / handwritten notes pass the
      // camera-EXIF positive-evidence test and would otherwise land in
      // Moments. If the OCR text reads like a paper document, demote the
      // classification so it lands in the Documents lens. Only fires when
      // CLIP/LLM landed on a generic photo bucket; explicit receipt/
      // screenshot/document classifications are respected.
      if (
        (classification === "photo" || classification === null) &&
        ocrLooksLikePaperDocument(preDescribeOcrText)
      ) {
        classification = "document";
        subClassification = null;
      }
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

  // Phase 7.2 — OCR-driven document override. Runs after the OCR pass so we
  // have real text to inspect. A phone photo of a receipt has camera EXIF
  // (Phase 7.1 routes it to Moments) AND OCR text — exactly the case the
  // taxonomy classifier misses. Demote those to `document` BEFORE deriveKind
  // reads `classification`. Skip when the classifier already landed on a
  // document/scan/receipt label — that path is already correct.
  if (
    mimeType.startsWith("image/") &&
    classification === "photo" &&
    (ocrLooksLikePaperDocument(imageOcrText) || isDocumentByOcr(imageOcrText))
  ) {
    classification = "document";
    subClassification = null;
  }

  // Task 20 + Phase 7.1 + ADR 0001 §4 — resolve KIND from final classification
  // + mime + real-camera-capture signals + heuristic inputs (widthPx, heightPx,
  // ocrText, subClassification). cameraEvidence was populated by the image
  // branch above; doc/video paths leave it empty (deriveKind short-circuits
  // on those mimes before checking exposure params, so no read is wasted).
  //
  // Re-read dims once at this scope so the doc/video branches (where the image
  // branch didn't run) still have width/height if available. Cheap one-row
  // SELECT; no impact on hot-path.
  const [kindDims] = mimeType.startsWith("image/")
    ? await db
        .select({
          widthPx: schema.assets.widthPx,
          heightPx: schema.assets.heightPx,
        })
        .from(schema.assets)
        .where(eq(schema.assets.id, assetId))
        .limit(1)
    : [{ widthPx: null as number | null, heightPx: null as number | null }];
  const kind = deriveKind({
    mimeType,
    classification,
    filename,
    ...cameraEvidence,
    widthPx: kindDims?.widthPx ?? null,
    heightPx: kindDims?.heightPx ?? null,
    subClassification,
    ocrText: imageOcrText,
  });

  await db
    .update(schema.assets)
    .set({
      processingState: "extracted",
      classification,
      description,
      subClassification,
      classifyMethod: classifyMethodLabel,
      classifyConfidence,
      kind,
    })
    .where(eq(schema.assets.id, assetId));

  await db
    .update(schema.assets)
    .set({ processingState: "ready" })
    .where(eq(schema.assets.id, assetId));

  // Face detection — only for real photographs. Screenshots, documents,
  // receipts, memes/art (classification != "photo") and non-images don't
  // carry faces worth clustering; running detection on them flooded the
  // People view with hundreds of junk clusters. Deferred to here (post-
  // classification) so the gate is reliable — the old upload-time enqueue
  // raced the classifier. The worker re-runs is non-idempotent, so this
  // fires exactly once per processed photo.
  if (classification === "photo" && mimeType.startsWith("image/")) {
    const [wsRow] = await db
      .select({ workspaceId: schema.assets.workspaceId })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1);
    if (wsRow) void tryEnqueueFaceDetect(assetId, wsRow.workspaceId, mimeType);
  }

  // ── Text layer / OCR. Image OCR already ran above (pre-describe) so the
  // caption could quote the visible text; here we only handle the document
  // and non-image branches. All failures are non-fatal — recorded via
  // ocrState.
  if (docOcrState !== null) {
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

    // ADR 0002 — unified path's `suggestedTags` is already a curated list,
    // so skip the extra plexoSuggestTags round-trip. Legacy path still
    // calls plexoSuggestTags because its description was produced without
    // tag-suggestion context.
    const llmTags = unifiedResultTopLevel
      ? unifiedResultTopLevel.suggestedTags
      : await plexoSuggestTags(
          plexoWorkspaceId,
          filename,
          classification,
          description,
        );
    const [asset] = await db
      .select({ workspaceId: schema.assets.workspaceId })
      .from(schema.assets)
      .where(eq(schema.assets.id, assetId))
      .limit(1);

    // Things = curated taxonomy (CLIP) + grounded LLM object tags only. The
    // raw vision labeller (`visionLabelsCarried`) is deliberately NOT folded
    // into tags: it emitted anatomy fragments + abstract noise ("Repetition",
    // "Forehead", "Pattern") that flooded Explore > Things. It still grounds
    // the caption above; it just no longer becomes a Thing.
    //
    // Dedupe case-insensitively but preserve the CLIP names' original casing
    // (taxonomy curates these display-ready, e.g. "Portraits" not "portraits").
    const seen = new Set<string>();
    const suggestedNames: string[] = [];
    for (const name of [...clipSuggestedTags, ...llmTags]) {
      const key = name.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      // Drop anatomy fragments / abstract visual-property / meta noise so
      // Things stays a meaningful-noun surface (Explore > Things). See
      // labelStoplist.ts.
      if (isJunkLabel(name)) continue;
      seen.add(key);
      suggestedNames.push(name);
    }

    // Re-scan hygiene: drop this asset's existing AI-suggested tag links
    // before re-attaching the fresh suggestions. Without this, a re-scan
    // ACCUMULATES labels — the stale, filename-derived "Things" the user is
    // complaining about would survive alongside the new grounded ones. Tags
    // the user created by hand (ai_suggested = false) are left untouched.
    if (asset) {
      await db.delete(schema.assetTags).where(
        and(
          eq(schema.assetTags.assetId, assetId),
          inArray(
            schema.assetTags.tagId,
            db
              .select({ id: schema.tags.id })
              .from(schema.tags)
              .where(
                and(
                  eq(schema.tags.workspaceId, asset.workspaceId),
                  eq(schema.tags.aiSuggested, true)
                )
              )
          )
        )
      );
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

  // Prefer the decoded preview so OCR works on HEIC/RAW originals the VLM
  // can't decode; fall back to the original until the preview derivative lands.
  const key =
    asset.previewKey ?? assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  let signedUrl: string;
  try {
    signedUrl = await storage().presignGet(key, { expiresIn: 300 });
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
