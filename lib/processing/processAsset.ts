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
  plexoDescribeImage,
  plexoPublishEvent,
  plexoStoreMemory,
  plexoSuggestTags,
  plexoVisionOcr,
} from "@/lib/plexo";
import { assetProcessingDurationSeconds } from "@/lib/metrics";

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
  try {
    await processAssetInner(params);
    endTimer({ outcome: "success" });
  } catch (err) {
    endTimer({ outcome: "failure" });
    throw err;
  }
}

async function processAssetInner(params: ProcessAssetParams): Promise<void> {
  const { assetId, userId, email, filename, mimeType, extractedText } = params;

  await db
    .update(schema.assets)
    .set({ processingState: "classified" })
    .where(eq(schema.assets.id, assetId));

  let classification: string;
  let description: string | null = null;
  let plexoWorkspaceId: string | null = null;

  if (plexoAvailable()) {
    plexoWorkspaceId = await plexoEnsureWorkspace(userId, email);
    classification = await plexoClassifyAsset(
      plexoWorkspaceId,
      filename,
      mimeType,
      extractedText ?? undefined
    );

    if (mimeType.startsWith("image/")) {
      description = await plexoDescribeImage(plexoWorkspaceId, filename, mimeType);
    }
  } else {
    classification = mimeType.startsWith("image/") ? "photo" : "document";
  }

  await db
    .update(schema.assets)
    .set({ processingState: "extracted", classification, description })
    .where(eq(schema.assets.id, assetId));

  await db
    .update(schema.assets)
    .set({ processingState: "ready" })
    .where(eq(schema.assets.id, assetId));

  // ── OCR: image-only. Failures are non-fatal — recorded via ocrState.
  if (plexoWorkspaceId && mimeType.startsWith("image/")) {
    await runOcrForAsset(assetId, plexoWorkspaceId).catch((err) => {
      console.warn("[fonto] OCR failed for asset", assetId, err);
    });
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

  const isDocClassification = DOCUMENT_CLASSIFICATIONS.has(classification);
  const isDocMime = DOCUMENT_TRIGGER_MIME.some((p) => mimeType.startsWith(p));
  if (isDocClassification || isDocMime) {
    void plexoPublishEvent("ext.fonto.document.processed", assetPayload);
  }

  if (classification === "receipt") {
    void plexoPublishEvent("ext.fonto.receipt.detected", {
      ...assetPayload,
      extractedText: extractedText?.slice(0, 500) ?? null,
    });
  }

  if (plexoWorkspaceId) {
    const memContent = [
      `[Fonto asset] ${filename}`,
      `Type: ${mimeType} | Classification: ${classification}`,
      description ? `Description: ${description}` : null,
      extractedText ? `Content: ${extractedText.slice(0, 800)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    void plexoStoreMemory(plexoWorkspaceId, memContent, {
      source: "fonto",
      assetId,
      classification,
      mimeType,
    });

    const suggestedNames = await plexoSuggestTags(
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

        await db
          .insert(schema.assetTags)
          .values({ assetId, tagId })
          .onConflictDoNothing();
      }
    }
  }
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

  const result = await plexoVisionOcr(plexoWorkspaceId, signedUrl);
  if (!result) {
    await db
      .update(schema.assets)
      .set({ ocrState: "failed" })
      .where(eq(schema.assets.id, assetId));
    return;
  }

  await db
    .update(schema.assets)
    .set({
      ocrText: result.text,
      ocrState: "ready",
    })
    .where(eq(schema.assets.id, assetId));

  if (result.text.length > 0) {
    void plexoPublishEvent("ext.fonto.asset.ocr_extracted", {
      assetId,
      filename: asset.filename,
      textLength: result.text.length,
      model: result.model,
    });
  }
}
