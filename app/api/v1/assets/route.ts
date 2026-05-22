// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { plexoPublishEvent } from "@/lib/plexo";
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
import { extractExif } from "@/lib/exif";
import { assetProcessingQueue, JobNames } from "@/lib/queue";
import {
  assetIngestTotal,
  classifyMime,
  httpRequestDurationSeconds,
} from "@/lib/metrics";

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Time the full POST lifetime and emit Prometheus metrics around it. We do
  // this in a wrapper so the existing flow below stays untouched — any new
  // return path inside `handlePost` flows through here.
  const endTimer = httpRequestDurationSeconds.startTimer({
    method: "POST",
    route: "/api/v1/assets",
  });
  let response: NextResponse;
  try {
    response = await handlePost(request);
  } catch (err) {
    endTimer({ status_code: "500" });
    throw err;
  }
  endTimer({ status_code: String(response.status) });
  return response;
}

async function handlePost(request: NextRequest): Promise<NextResponse> {
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

  // Extract EXIF / IPTC / XMP synchronously. Cheap (<10ms typical) and the
  // capture date needs to be correct on the very first render — async
  // backfill would briefly show wrong dates in the timeline. extractExif
  // never throws; an unreadable header just returns all nulls.
  const exifData = await extractExif(buffer, mimeType);

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
      // Prefer the EXIF capture date; fall back to upload time if the file
      // has no usable timestamp (non-image, stripped metadata, etc.).
      capturedAt: exifData.capturedAt ?? new Date(),
      phash,
      colors,
      exif: exifData.raw,
      latitude: exifData.latitude,
      longitude: exifData.longitude,
      cameraMake: exifData.cameraMake,
      cameraModel: exifData.cameraModel,
      lensModel: exifData.lensModel,
      focalLength: exifData.focalLength,
      fNumber: exifData.fNumber,
      iso: exifData.iso,
      exposureTime: exifData.exposureTime,
      orientation: exifData.orientation,
      widthPx: exifData.widthPx,
      heightPx: exifData.heightPx,
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

    // Enqueue processing pipeline (classification, tags, memory, OCR) on the
    // BullMQ asset-processing queue. The request returns immediately; the
    // worker container picks up the job and runs `processAsset` against the
    // same database. A container restart no longer drops in-flight work.
    try {
      await assetProcessingQueue().add(JobNames.ProcessAsset, {
        assetId: asset.id,
        workspaceId,
        userId: user.id,
        email: user.email,
        filename: file.name,
        mimeType,
        extractedText,
      });
    } catch (err) {
      // Never fail the upload because the queue is briefly unavailable —
      // surface it to logs and let the next backfill cron pick this up.
      console.error("[fonto] failed to enqueue process-asset job:", err);
    }

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

    assetIngestTotal.labels({ mime_class: classifyMime(mimeType) }).inc(1);

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
