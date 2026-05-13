// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, desc, isNotNull, sql } from "drizzle-orm";
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
import {
  computePHash,
  extractPalette,
  hammingDistance,
  type PaletteColor,
} from "@/lib/perceptual";
import {
  findNearestAssetByPhashGraph,
  fontoGraphConfigured,
  mirrorAssetToGraph,
} from "@/lib/fonto-graph";

const DOCUMENT_CLASSIFICATIONS = new Set(["document", "receipt", "scan", "report", "form", "contract", "letter"]);
const DOCUMENT_TRIGGER_MIME = ["application/pdf", "text/", "image/tiff"];

// Hamming distance threshold for "near-duplicate" pHash matches.
// 0–4 = visually identical resizes/recompresses
// 5–10 = same scene, different crop or color shift
// 11+  = different image
const PHASH_DUPLICATE_THRESHOLD = 5;

/**
 * Compute pHash + dominant colors from an image buffer. Best-effort: any
 * decode/processing failure is swallowed and logged so the rest of the
 * upload pipeline continues unaffected.
 */
async function computePerceptualMetadata(
  buffer: Buffer,
  mimeType: string
): Promise<{ phash: bigint | null; colors: PaletteColor[] | null }> {
  if (!mimeType.startsWith("image/")) {
    // Note: video frame pHash is documented as a future enhancement —
    // sharp can't decode video, so we skip until ffmpeg integration lands.
    return { phash: null, colors: null };
  }
  try {
    const [phash, colors] = await Promise.all([
      computePHash(buffer).catch(() => null),
      extractPalette(buffer).catch(() => null),
    ]);
    return { phash, colors };
  } catch (err) {
    console.warn("[fonto] perceptual metadata extraction failed:", err);
    return { phash: null, colors: null };
  }
}

async function processAsset(
  assetId: string,
  userId: string,
  email: string | undefined,
  filename: string,
  mimeType: string,
  extractedText: string | null
) {
  try {
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

    // ── OCR: image-only, fire-and-forget. Failures are non-fatal.
    if (plexoWorkspaceId && mimeType.startsWith("image/")) {
      void runOcrForAsset(assetId, plexoWorkspaceId).catch((err) => {
        console.warn("[fonto] OCR failed for asset", assetId, err);
      });
    } else if (!mimeType.startsWith("image/")) {
      // Non-image: mark OCR as skipped so the cron doesn't try to OCR PDFs.
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

    // Emit ext.fonto.asset.processed
    void plexoPublishEvent("ext.fonto.asset.processed", assetPayload);

    // Emit ext.fonto.document.processed for document-class assets
    const isDocClassification = DOCUMENT_CLASSIFICATIONS.has(classification);
    const isDocMime = DOCUMENT_TRIGGER_MIME.some((p) => mimeType.startsWith(p));
    if (isDocClassification || isDocMime) {
      void plexoPublishEvent("ext.fonto.document.processed", assetPayload);
    }

    // Emit ext.fonto.receipt.detected with extraction hint
    if (classification === "receipt") {
      void plexoPublishEvent("ext.fonto.receipt.detected", {
        ...assetPayload,
        extractedText: extractedText?.slice(0, 500) ?? null,
      });
    }

    // memory.write with asset metadata
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

      // Auto-tagging
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
  } catch (err) {
    console.error("[fonto] processAsset error:", err);
    await db
      .update(schema.assets)
      .set({ processingState: "captured" })
      .where(eq(schema.assets.id, assetId));
  }
}

/**
 * Run OCR on an image asset via Plexo's vision endpoint and persist the
 * result. Marks the asset's `ocrState` accordingly. Used both inline (after
 * upload) and by the nightly backfill cron.
 */
export async function runOcrForAsset(
  assetId: string,
  plexoWorkspaceId: string
): Promise<void> {
  // Look up the asset and presign a 5-minute URL for Plexo's vision call.
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

/**
 * Find any existing image asset in the same workspace whose pHash is within
 * Hamming-distance threshold. Returns the first match (or null). Filters out
 * trashed/purged assets and the asset being uploaded itself.
 */
async function findPHashNearDuplicate(
  workspaceId: string,
  newPHash: bigint,
  excludeAssetId?: string
): Promise<{ id: string; filename: string; capturedAt: string | null; createdAt: string; mimeType: string; distance: number } | null> {
  const candidates = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      capturedAt: schema.assets.capturedAt,
      createdAt: schema.assets.createdAt,
      phash: schema.assets.phash,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        isNotNull(schema.assets.phash)
      )
    );

  let best: { id: string; filename: string; capturedAt: Date | null; createdAt: Date; mimeType: string; distance: number } | null = null;
  for (const row of candidates) {
    if (row.phash == null) continue;
    if (excludeAssetId && row.id === excludeAssetId) continue;
    const d = hammingDistance(BigInt(row.phash), newPHash);
    if (d <= PHASH_DUPLICATE_THRESHOLD && (!best || d < best.distance)) {
      best = {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        capturedAt: row.capturedAt,
        createdAt: row.createdAt,
        distance: d,
      };
    }
  }
  if (!best) return null;
  return {
    id: best.id,
    filename: best.filename,
    mimeType: best.mimeType,
    capturedAt: best.capturedAt ? best.capturedAt.toISOString() : null,
    createdAt: best.createdAt.toISOString(),
    distance: best.distance,
  };
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });

  const workspaceId = workspaces[0].id;
  const { searchParams } = request.nextUrl;
  const mimeFilter = searchParams.get("mime");
  const subtypeFilter = searchParams.get("subtype");
  const lifecycle = searchParams.get("lifecycle") ?? "active";
  const validLifecycles = ["active", "archivable", "archived", "trashed"];
  const lifecycleFilter = validLifecycles.includes(lifecycle) ? lifecycle : "active";

  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, lifecycleFilter)
      )
    )
    .orderBy(desc(schema.assets.createdAt));

  const filtered = rows
    .filter((a) => !mimeFilter || a.mimeType.startsWith(mimeFilter))
    .filter((a) => !subtypeFilter || a.classification === subtypeFilter);

  return NextResponse.json({ assets: filtered.map(serializeAsset) });
}

/**
 * Serialize an asset row for JSON output. Drizzle's `bigint` mode 'bigint'
 * returns a native BigInt for `phash`, which `JSON.stringify` cannot encode
 * — convert to string. All other fields pass through unchanged.
 */
function serializeAsset<T extends { phash?: bigint | null }>(asset: T): T & { phash: string | null } {
  return {
    ...asset,
    phash: asset.phash != null ? asset.phash.toString() : null,
  };
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }
  const workspaceId = workspaces[0].id;

  // Idempotency: check X-Upload-Id header
  const uploadId = request.headers.get("X-Upload-Id");
  if (uploadId) {
    const [existingSession] = await db
      .select()
      .from(schema.uploadSessions)
      .where(
        and(
          eq(schema.uploadSessions.uploadId, uploadId),
          eq(schema.uploadSessions.userId, user.id)
        )
      )
      .limit(1);

    if (existingSession?.state === "completed" && existingSession.assetId) {
      const [existingAsset] = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.id, existingSession.assetId))
        .limit(1);
      if (existingAsset) {
        return NextResponse.json({ asset: serializeAsset(existingAsset) }, { status: 200 });
      }
    }
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const source = (formData.get("source") as string | null) ?? "web-upload";

  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "File too large. Maximum upload size is 50 MB." },
      { status: 413 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // SHA-256 dedup: return existing non-purged asset if hash matches
  const [duplicate] = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.sha256, sha256),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .limit(1);

  if (duplicate) {
    return NextResponse.json({ asset: serializeAsset(duplicate), deduplicated: true }, { status: 200 });
  }

  // Extract text from text/* files immediately
  let extractedText: string | null = null;
  if (file.type.startsWith("text/") && buffer.length < 500_000) {
    extractedText = buffer.toString("utf-8").slice(0, 10_000);
  }

  // Compute perceptual hash + dominant colors for image assets. Best-effort —
  // a decode failure should never block the upload itself.
  const mimeType = file.type || "application/octet-stream";
  const { phash, colors } = await computePerceptualMetadata(buffer, mimeType);

  // pHash near-duplicate check: if the hash matches an existing asset within
  // Hamming distance ≤ 5, surface the match in the response so the UI can
  // prompt "Possible duplicate of …". The new asset is still uploaded — the
  // user picks Keep both / Replace / Cancel client-side.
  let possibleDuplicate:
    | { assetId: string; filename: string; capturedAt: string | null; createdAt: string; distance: number; thumbUrl: string }
    | null = null;
  if (phash != null) {
    const match = await findPHashNearDuplicate(workspaceId, phash);
    if (match) {
      possibleDuplicate = {
        assetId: match.id,
        filename: match.filename,
        capturedAt: match.capturedAt,
        createdAt: match.createdAt,
        distance: match.distance,
        thumbUrl: `/api/v1/assets/${match.id}/url`,
      };
    }
    // Phase D-Fonto-1 (ADR 0027) shadow mode — run the same lookup against
    // the FalkorDB vector index and log any disagreement. Read-only; the
    // possibleDuplicate surface still drives off the postgres scan.
    if (fontoGraphConfigured()) {
      void (async () => {
        try {
          const graphMatch = await findNearestAssetByPhashGraph({
            workspaceId,
            phash,
            scoreThreshold: Math.sqrt(PHASH_DUPLICATE_THRESHOLD),
          });
          const pgId = match?.id ?? null;
          const gId = graphMatch?.assetId ?? null;
          if (pgId !== gId) {
            console.warn("[fonto-graph] phash NN disagreement", {
              workspaceId,
              postgres: pgId,
              graph: gId,
              graphScore: graphMatch?.score,
            });
          }
        } catch (err) {
          console.warn("[fonto-graph] shadow phash NN failed:", err);
        }
      })();
    }
  }

  // Open upload session for idempotency tracking
  let sessionId: string | null = null;
  if (uploadId) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [session] = await db
      .insert(schema.uploadSessions)
      .values({ uploadId, userId: user.id, workspaceId, expiresAt })
      .onConflictDoNothing()
      .returning({ id: schema.uploadSessions.id });
    sessionId = session?.id ?? null;
  }

  const [asset] = await db
    .insert(schema.assets)
    .values({
      workspaceId,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      sha256,
      syncState: "syncing",
      processingState: "captured",
      lifecycleState: "active",
      source,
      extractedText,
      capturedAt: new Date(),
      phash,
      colors,
      ocrState: mimeType.startsWith("image/") ? "pending" : "skipped",
    })
    .returning();

  const key = assetStorageKey(workspaceId, asset.id, file.name);
  const bucket = process.env.R2_BUCKET!;

  try {
    // Block 201 until R2 confirms — no fire-and-forget on upload
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: file.type || "application/octet-stream",
        ContentLength: file.size,
      })
    );

    await db
      .update(schema.assets)
      .set({ syncState: "synced" })
      .where(eq(schema.assets.id, asset.id));

    // Mark upload session completed
    if (sessionId) {
      await db
        .update(schema.uploadSessions)
        .set({ state: "completed", assetId: asset.id })
        .where(eq(schema.uploadSessions.id, sessionId));
    }

    // Emit ext.fonto.asset.uploaded (non-blocking)
    void plexoPublishEvent("ext.fonto.asset.uploaded", {
      assetId: asset.id,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256,
      source,
    });

    // Fire-and-forget processing pipeline (classification, tags, memory, OCR)
    processAsset(asset.id, user.id, user.email, file.name, file.type, extractedText).catch(
      console.error
    );

    // Phase D-Fonto-1 (ADR 0027) — mirror the new Asset to the workspace
    // fonto graph so subsequent uploads have a populated vector index to
    // query against. Fire-and-forget; failures stay shadow until cutover.
    if (phash != null && fontoGraphConfigured()) {
      void mirrorAssetToGraph({
        workspaceId,
        assetId: asset.id,
        filename: file.name,
        mimeType,
        lifecycleState: "active",
        phash,
      }).catch((err) => console.warn("[fonto-graph] asset mirror failed:", err));
    }

    return NextResponse.json(
      {
        asset: serializeAsset({ ...asset, syncState: "synced" }),
        ...(possibleDuplicate ? { possibleDuplicate } : {}),
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[fonto] R2 upload failed:", err);
    await db
      .update(schema.assets)
      .set({ syncState: "error" })
      .where(eq(schema.assets.id, asset.id));
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
