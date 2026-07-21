// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared asset row creation: dedup check + EXIF + perceptual hash + insert +
// queue enqueue + plexo publish. Both the legacy multipart POST and the new
// /complete (presigned PUT) route call into this so we never drift on the
// per-upload bookkeeping.
//
// What this helper does NOT do:
// - It does not handle R2 storage. The legacy route uploads a buffer to R2
//   after a successful insert; the presigned-PUT path has already pushed the
//   object to R2 before getting here. Both call sites pass the in-memory
//   buffer for EXIF + pHash extraction.
// - It does not own the response shape. Each route serializes the returned
//   asset its own way (the legacy route attaches `possibleDuplicate`, etc.).

import { createHash } from "crypto";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { plexoPublishEvent } from "@/lib/plexo";
import {
  computePHash,
  extractPalette,
  hammingDistance,
  phashToDb,
  phashFromDb,
  type PaletteColor,
} from "@/lib/perceptual";
// fonto-graph (FalkorDB mirror) was retired in Phase 4.3 (ADR 0002) in favor
// of pgvector. The module and its callers are gone; pHash NN now happens
// in-DB via findPHashNearDuplicate() above.
import { extractExif, dateFromFilename } from "@/lib/exif";
import { nearestPlace, formatPlaceName } from "@/lib/geocoder";
import { assetProcessingQueue, clipDedupCheckQueue, JobNames } from "@/lib/queue";
import { emitWebhook } from "@/lib/webhooks/emit";
import { emitActivity } from "@/lib/activity/emit";
import { nextSeq } from "@/lib/db/seq";
import { deriveScope, type Scope } from "@/lib/scope";
import { embedImage, visionServiceConfigured } from "@/lib/plexo-vision";
import { nearestNeighbors } from "@/lib/vectors";
// Phase 1.1 `thumbnailQueue` + `JobNames.GenerateThumbnails` resolved
// dynamically below so this module stays buildable if those exports
// disappear in a future refactor (or in a parallel-worktree merge with
// 1.1 not yet landed).
import { assetIngestTotal, classifyMime } from "@/lib/metrics";

// Hamming distance threshold for "near-duplicate" pHash matches.
// 0–4 = visually identical resizes/recompresses
// 5–10 = same scene, different crop or color shift
// 11+  = different image
export const PHASH_DUPLICATE_THRESHOLD = 5;

// Phase 4.5 — CLIP-similarity threshold for the second-pass dedup check.
// 0.92 matches Immich's default ("clearly the same scene, possibly a re-edit
// or different crop"). Tunable via CLIP_DEDUP_THRESHOLD.
export const CLIP_DUPLICATE_THRESHOLD_DEFAULT = 0.92;
// Phase 4.5 — inline embed budget. If the vision call exceeds this we bail
// out and defer the dedup pass to the worker so the upload response isn't
// blocked. Tunable via CLIP_DEDUP_INLINE_TIMEOUT_MS.
export const CLIP_DEDUP_INLINE_TIMEOUT_MS_DEFAULT = 2000;

function clipDedupThreshold(): number {
  const raw = process.env.CLIP_DEDUP_THRESHOLD;
  if (!raw) return CLIP_DUPLICATE_THRESHOLD_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return CLIP_DUPLICATE_THRESHOLD_DEFAULT;
  return n;
}

function clipDedupInlineTimeoutMs(): number {
  const raw = process.env.CLIP_DEDUP_INLINE_TIMEOUT_MS;
  if (!raw) return CLIP_DEDUP_INLINE_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return CLIP_DEDUP_INLINE_TIMEOUT_MS_DEFAULT;
  return Math.floor(n);
}

export type Asset = typeof schema.assets.$inferSelect;

/**
 * Phase 4.5 — extended dedup hint surfaced to the client upload response.
 * `method` discriminates the detection path (pHash vs CLIP), `distance`
 * carries pHash Hamming OR CLIP cosine similarity depending on method, and
 * `confidence` is a normalised UI bucket derived from `method`+`distance`:
 *
 *   - pHash: <=2 = high, else medium
 *   - CLIP:  >=0.95 = high, >=0.93 = medium, else low
 */
export type DuplicateDetectionMethod = "phash" | "clip";
export type DuplicateConfidence = "high" | "medium" | "low";

export interface PossibleDuplicate {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  createdAt: string;
  /** Hamming distance for pHash matches; cosine similarity for CLIP matches. */
  distance: number;
  thumbUrl: string;
  /** Phase 4.5 — which detection path produced this match. */
  method: DuplicateDetectionMethod;
  /** Phase 4.5 — UI bucket for the banner styling / wording. */
  confidence: DuplicateConfidence;
}

function phashConfidence(distance: number): DuplicateConfidence {
  return distance <= 2 ? "high" : "medium";
}

function clipConfidence(similarity: number): DuplicateConfidence {
  if (similarity >= 0.95) return "high";
  if (similarity >= 0.93) return "medium";
  return "low";
}

export interface CreateAssetInput {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256. If undefined, computed from the buffer here. */
  sha256?: string;
  /** Full asset buffer for EXIF / pHash / palette extraction. */
  buffer: Buffer;
  source: string;
  /**
   * ADR 0008 — explicit scope choice (user-selected at upload). Wins over the
   * folder-prefix heuristic. Omit to let `deriveScope` decide (defaults
   * PERSONAL unless the directory matches a configured shoot prefix).
   */
  scope?: Scope | null;
  /**
   * Phase 3.5 — pre-normalised virtual folder path (or null). Callers are
   * responsible for running raw client input through
   * `normalizeDirectoryPath()` before passing it here; this column trusts
   * what it receives.
   */
  directoryPath?: string | null;
  /**
   * Pre-reserved asset UUID. When supplied (presigned-PUT path), the INSERT
   * uses this ID so the storage key — which embeds the same UUID — stays
   * aligned with the asset row. Ignored on SHA-256 dedup (existing row wins).
   */
  preReservedId?: string;
  /**
   * Phase 0 (media import) — explicit metadata that takes precedence over the
   * EXIF-derived values. Google Takeout sidecar JSON carries authoritative
   * `photoTakenTime` / `geoData` / `description` that should win over (often
   * missing or stripped) embedded EXIF. Applied AFTER EXIF extraction so EXIF
   * remains the fallback for any field left undefined. Omit entirely (the
   * Amazon EXIF-only path) and this is a complete no-op.
   */
  metadataOverride?: {
    capturedAt?: Date;
    latitude?: number;
    longitude?: number;
    description?: string;
  };
}

export interface CreateAssetResult {
  /** The newly-inserted asset row. */
  asset: Asset;
  /** True iff a SHA-256 match was found and we returned the existing row. */
  deduplicated: boolean;
  /** Near-duplicate by pHash (NOT the same image; the new asset still uploaded). */
  possibleDuplicate: PossibleDuplicate | null;
}

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
  scope: Scope,
  excludeAssetId?: string
): Promise<{
  id: string;
  filename: string;
  capturedAt: string | null;
  createdAt: string;
  mimeType: string;
  distance: number;
} | null> {
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
        // ADR 0008 — keep near-dup hints within the incoming asset's scope so
        // a PERSONAL upload never matches a SHOOT photo (and vice-versa).
        eq(schema.assets.scope, scope),
        isNotNull(schema.assets.phash)
      )
    );

  let best: {
    id: string;
    filename: string;
    capturedAt: Date | null;
    createdAt: Date;
    mimeType: string;
    distance: number;
  } | null = null;
  for (const row of candidates) {
    if (row.phash == null) continue;
    if (excludeAssetId && row.id === excludeAssetId) continue;
    const d = hammingDistance(phashFromDb(BigInt(row.phash)), newPHash);
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

/**
 * Phase 4.5 — race the inline CLIP embed against the budget. Returns the
 * embedding if it lands in time; returns `"timeout"` if the budget was
 * exceeded (so the caller can defer to the worker); returns `null` on any
 * other failure (service unconfigured, network error, decode failure) — in
 * which case the caller should silently skip the CLIP pass.
 *
 * The actual `embedImage()` stub returns `null` until Phase 4.2 ships, so in
 * practice this function will short-circuit to `null` on every call. Wiring
 * the race up now keeps the createAssetRow flow stable across both worlds.
 */
async function embedImageWithBudget(
  buffer: Buffer,
  mimeType: string,
  budgetMs: number
): Promise<number[] | "timeout" | null> {
  if (!visionServiceConfigured()) return null;
  if (!mimeType.startsWith("image/")) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<number[] | "timeout" | null>([
      // Phase 4.2 client returns { vector, modelId }; we only need vector here.
      // Internal timeout (15s default) is independent of the inline budget —
      // the budget races against the call as a whole.
      embedImage(buffer)
        .then((r) => r.vector)
        .catch((err) => {
          console.warn("[fonto] inline CLIP embed failed:", err);
          return null;
        }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Phase 4.5 — fire-and-forget enqueue of the worker fallback job. Same
 * defensive shape as `tryEnqueueThumbnail`: never throws, only logs.
 */
async function tryEnqueueClipDedupCheck(assetId: string, workspaceId: string): Promise<void> {
  try {
    await clipDedupCheckQueue().add(JobNames.ClipDedupCheck, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] clip-dedup-check enqueue skipped:", err);
  }
}

/**
 * Phase 4.5 — given a freshly-computed embedding, find the best workspace-
 * scoped CLIP neighbor (excluding the asset itself) above the configured
 * similarity threshold. Returns metadata for the duplicate banner, or null.
 */
async function findClipNearDuplicate(
  workspaceId: string,
  clipVec: number[],
  excludeAssetId: string,
  threshold: number,
  scope: Scope
): Promise<{
  id: string;
  filename: string;
  capturedAt: string | null;
  createdAt: string;
  similarity: number;
} | null> {
  // Phase 4.3's nearestNeighbors signature: (workspaceId, vec, limit, threshold).
  // Filter excludeAssetId inline (the column-aware predicate is cheap enough).
  let matches: Awaited<ReturnType<typeof nearestNeighbors>>;
  try {
    matches = (await nearestNeighbors(workspaceId, clipVec, 5, threshold, scope)).filter(
      (m) => m.assetId !== excludeAssetId
    );
  } catch (err) {
    console.warn("[fonto] CLIP nearestNeighbors failed:", err);
    return null;
  }
  if (matches.length === 0) return null;
  // Sorted desc by similarity by contract; take the top.
  const top = matches[0];
  // Look up the matching row's display metadata.
  const [row] = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      capturedAt: schema.assets.capturedAt,
      createdAt: schema.assets.createdAt,
    })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.id, top.assetId),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    similarity: top.similarity,
  };
}

/**
 * Try to enqueue a thumbnail job, but don't crash the build if Phase 1.1
 * hasn't shipped the queue export yet. The import is dynamic + try/catch so a
 * missing symbol stays a runtime warning rather than a TS error.
 */
async function tryEnqueueThumbnail(assetId: string, workspaceId: string, mimeType: string): Promise<void> {
  // Mirror generateThumbnails' dispatcher eligibility: images, videos
  // (keyframe extract), and PDFs (poppler first-page render). Everything
  // else the dispatcher skips, so don't bother enqueuing.
  if (
    !mimeType.startsWith("image/") &&
    !mimeType.startsWith("video/") &&
    mimeType !== "application/pdf"
  ) {
    return;
  }
  try {
    const mod = (await import("@/lib/queue")) as unknown as {
      thumbnailQueue?: () => { add: (n: string, p: unknown) => Promise<unknown> };
      JobNames?: Record<string, string>;
    };
    if (typeof mod.thumbnailQueue !== "function") return;
    const jobName = mod.JobNames?.GenerateThumbnails ?? "generate-thumbnails";
    await mod.thumbnailQueue().add(jobName, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] thumbnail enqueue skipped:", err);
  }
}

/**
 * Phase 4.2 — try to enqueue a CLIP image embedding job. Same dynamic-import
 * pattern as `tryEnqueueThumbnail` so an export drift (or the queue helper
 * being temporarily absent during a refactor) degrades to a console warning
 * rather than breaking uploads. Non-image MIME types short-circuit.
 */
async function tryEnqueueClipEmbed(assetId: string, workspaceId: string, mimeType: string): Promise<void> {
  if (!mimeType.startsWith("image/")) return;
  try {
    const mod = (await import("@/lib/queue")) as unknown as {
      clipEmbeddingQueue?: () => { add: (n: string, p: unknown) => Promise<unknown> };
      JobNames?: Record<string, string>;
    };
    if (typeof mod.clipEmbeddingQueue !== "function") return;
    const jobName = mod.JobNames?.EmbedAsset ?? "embed-asset";
    await mod.clipEmbeddingQueue().add(jobName, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] clip embed enqueue skipped:", err);
  }
}

/**
 * Phase 5.1 — try to enqueue a face-detect job. Same dynamic-import pattern
 * as the thumbnail/CLIP-embed enqueues above. Skips non-image MIME types.
 * The worker handler reads the asset (and its thumbnail) from Postgres/R2,
 * so the payload stays tiny.
 *
 * Enqueued alongside the thumbnail job. The face-detect worker prefers the
 * 1080px preview derivative; if it hasn't been generated yet, it falls
 * back to the original. (Both downloads are R2 GETs — equivalent cost.)
 */
export async function tryEnqueueFaceDetect(
  assetId: string,
  workspaceId: string,
  mimeType: string
): Promise<void> {
  if (!mimeType.startsWith("image/")) return;
  try {
    const mod = (await import("@/lib/queue")) as unknown as {
      faceDetectQueue?: () => { add: (n: string, p: unknown) => Promise<unknown> };
      JobNames?: Record<string, string>;
    };
    if (typeof mod.faceDetectQueue !== "function") return;
    const jobName = mod.JobNames?.FaceDetect ?? "face-detect";
    await mod.faceDetectQueue().add(jobName, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] face-detect enqueue skipped:", err);
  }
}

/**
 * Phase B3 (storage placement) — try to enqueue a mirror-sync job for the
 * asset's original. Same fault-tolerant dynamic-import pattern as the other
 * enqueues. NO mime filter (every original is mirrored, not just images). The
 * worker handler reads the effective policy from Postgres and no-ops unless the
 * workspace/asset policy keeps a local copy, so it's cheap to always enqueue.
 */
async function tryEnqueueStorageSync(assetId: string, workspaceId: string): Promise<void> {
  try {
    const mod = (await import("@/lib/queue")) as unknown as {
      storageSyncQueue?: () => { add: (n: string, p: unknown) => Promise<unknown> };
      JobNames?: Record<string, string>;
    };
    if (typeof mod.storageSyncQueue !== "function") return;
    const jobName = mod.JobNames?.StorageSync ?? "storage-sync";
    await mod.storageSyncQueue().add(jobName, { assetId, workspaceId });
  } catch (err) {
    console.warn("[fonto] storage-sync enqueue skipped:", err);
  }
}

/**
 * Enqueue the full recognition pipeline for an asset: classify/describe/OCR
 * (ProcessAsset), thumbnail, CLIP embedding, and face detection. Shared by
 * the upload path (createAssetRow) and the user-triggered re-scan endpoints
 * so they stay in lockstep. Each leg is individually fault-tolerant.
 */
export async function enqueueAssetProcessing(args: {
  assetId: string;
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  filename: string;
  mimeType: string;
  extractedText?: string | null;
}): Promise<void> {
  const { assetId, workspaceId, userId, userEmail, filename, mimeType, extractedText } = args;
  try {
    await assetProcessingQueue().add(JobNames.ProcessAsset, {
      assetId,
      workspaceId,
      userId,
      email: userEmail ?? undefined,
      filename,
      mimeType,
      extractedText: extractedText ?? undefined,
    });
  } catch (err) {
    console.error("[fonto] failed to enqueue process-asset job:", err);
  }
  await tryEnqueueThumbnail(assetId, workspaceId, mimeType);
  void tryEnqueueClipEmbed(assetId, workspaceId, mimeType);
  // Phase B3 — mirror the original to local for `mirror`-policy workspaces.
  // No mime filter; the handler no-ops for non-mirror policies.
  void tryEnqueueStorageSync(assetId, workspaceId);
  // Face detection is NOT enqueued here. It's deferred to processAsset (after
  // classification), where it only fires for `classification === "photo"` —
  // enqueuing at upload raced the classifier and ran face-detect on every
  // screenshot/document, flooding the People view with junk clusters.
}

/**
 * Insert (or short-circuit-return existing) an asset row from an in-memory
 * buffer. Both `/api/v1/assets` (legacy multipart) and
 * `/api/v1/assets/:id/complete` (presigned PUT) funnel through here.
 */
export async function createAssetRow(input: CreateAssetInput): Promise<CreateAssetResult> {
  const { workspaceId, userId, userEmail, filename, mimeType, sizeBytes, buffer, source, preReservedId } = input;
  const directoryPath = input.directoryPath ?? null;
  const sha256 = input.sha256 ?? createHash("sha256").update(buffer).digest("hex");
  // ADR 0008 — inference-free scope assignment. Explicit user choice wins;
  // else a configured shoot-folder prefix; else PERSONAL.
  const resolvedScope = deriveScope({ explicit: input.scope, directoryPath });

  // SHA-256 dedup: return existing non-purged asset if hash matches.
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
    return { asset: duplicate, deduplicated: true, possibleDuplicate: null };
  }

  // Extract text from text/* files immediately.
  let extractedText: string | null = null;
  if (mimeType.startsWith("text/") && buffer.length < 500_000) {
    extractedText = buffer.toString("utf-8").slice(0, 10_000);
  }

  const { phash, colors } = await computePerceptualMetadata(buffer, mimeType);
  const exifData = await extractExif(buffer, mimeType);

  // Phase 0 (media import) — resolve capturedAt/geo/description with the
  // optional metadataOverride taking precedence over EXIF. EXIF is the
  // fallback for any override field left undefined; when `metadataOverride`
  // is absent these all collapse back to the EXIF values (a no-op).
  const override = input.metadataOverride;
  const resolvedLatitude = override?.latitude ?? exifData.latitude;
  const resolvedLongitude = override?.longitude ?? exifData.longitude;
  const resolvedCapturedAt: Date | null =
    override?.capturedAt ?? exifData.capturedAt ?? dateFromFilename(filename);
  const resolvedDescription: string | null = override?.description ?? null;

  // Phase 5.2 — reverse-geocode the GPS pair to a human-readable place name
  // ("Reykjavík, IS") for timeline + map UX. Skips when either coord is
  // missing; returns null on a polar / open-ocean photo. The lookup is
  // O(log n) over an in-memory KDBush so the upload latency hit is sub-ms.
  let placeName: string | null = null;
  if (resolvedLatitude != null && resolvedLongitude != null) {
    try {
      const hit = await nearestPlace(resolvedLatitude, resolvedLongitude);
      if (hit) placeName = formatPlaceName(hit);
    } catch (err) {
      console.warn("[fonto] reverse-geocode failed:", err);
    }
  }

  let possibleDuplicate: PossibleDuplicate | null = null;
  if (phash != null) {
    const match = await findPHashNearDuplicate(workspaceId, phash, resolvedScope);
    if (match) {
      possibleDuplicate = {
        assetId: match.id,
        filename: match.filename,
        capturedAt: match.capturedAt,
        createdAt: match.createdAt,
        distance: match.distance,
        thumbUrl: `/api/v1/assets/${match.id}/url`,
        method: "phash",
        confidence: phashConfidence(match.distance),
      };
    }
  }

  // Phase 2.3 — allocate this row's delta-sync seq before insert so it
  // appears on the very first `/sync/assets` page after creation.
  const assetSeq = await nextSeq(workspaceId, "asset");

  const [asset] = await db
    .insert(schema.assets)
    .values({
      ...(preReservedId ? { id: preReservedId } : {}),
      workspaceId,
      filename,
      mimeType,
      sizeBytes,
      sha256,
      seq: assetSeq,
      // The presigned-PUT path has already written the object to R2 before
      // calling here, so the row starts `synced`. The legacy multipart path
      // overrides this to `syncing` and flips to `synced` after its
      // PutObjectCommand completes — see the caller for that wrinkle.
      syncState: "synced",
      processingState: "captured",
      lifecycleState: "active",
      // ADR 0008 — authoritative partition; defaults PERSONAL (see deriveScope).
      scope: resolvedScope,
      source,
      extractedText,
      // Override (Takeout sidecar) wins; then EXIF date; then a date parsed
      // from the filename (screenshots / web / Drive images have no EXIF).
      // NEVER fall back to "now" — a date-less asset stamped with the import
      // time floods the current month and breaks the timeline + Memories.
      // Null ⇒ treated as undated.
      capturedAt: resolvedCapturedAt,
      // Convert the unsigned 64-bit pHash to signed two's-complement before
      // handing it to Drizzle — Postgres BIGINT is signed int8 and overflows
      // when the high bit is set (~50% of natural images). phashFromDb()
      // reverses this on read so in-process Hamming math sees the canonical
      // unsigned value.
      phash: phash != null ? phashToDb(phash) : null,
      colors,
      exif: exifData.raw,
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
      placeName,
      // Only set when a metadataOverride supplied one — leaves the column at
      // its NULL default for every existing caller (no-op without override).
      ...(resolvedDescription != null ? { description: resolvedDescription } : {}),
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
      directoryPath,
    })
    .returning();

  // ext.fonto.asset.uploaded (fire-and-forget).
  void plexoPublishEvent("ext.fonto.asset.uploaded", {
    assetId: asset.id,
    filename,
    mimeType,
    sizeBytes,
    sha256,
    source,
  });

  // Phase 7a — workspace activity feed (asset.uploaded). Fire-and-forget;
  // emitActivity swallows its own failures. targetType/targetId let the
  // feed + digest resolve the asset (and render a micro-thumb).
  void emitActivity({
    workspaceId,
    actorUserId: userId,
    kind: "asset.uploaded",
    targetType: "asset",
    targetId: asset.id,
    payload: { assetId: asset.id, filename, mimeType, source },
  });

  // Phase 2.4 — outbound webhook (asset.uploaded). Best-effort: emitWebhook
  // swallows its own failures so a Redis hiccup never breaks an upload.
  await emitWebhook(workspaceId, "asset.uploaded", {
    assetId: asset.id,
    workspaceId,
    filename,
    mimeType,
    sizeBytes,
    sha256,
    source,
    uploadedAt: asset.createdAt.toISOString(),
  });

  // Enqueue the full recognition pipeline (ProcessAsset + thumbnail + CLIP
  // embed + face detect). Shared with the re-scan endpoints.
  await enqueueAssetProcessing({
    assetId: asset.id,
    workspaceId,
    userId,
    userEmail,
    filename,
    mimeType,
    extractedText,
  });

  // Phase 4.5 — second-pass CLIP-similarity dedup check. Only runs for
  // image assets and only when pHash didn't already produce a hit. If the
  // inline embed takes longer than CLIP_DEDUP_INLINE_TIMEOUT_MS we hand
  // off to the BullMQ worker so the upload response isn't blocked.
  if (
    process.env.FONTO_IMPORT_SKIP_INLINE_CLIP !== "1" &&
    mimeType.startsWith("image/") &&
    possibleDuplicate == null
  ) {
    const inlineBudget = clipDedupInlineTimeoutMs();
    const clipResult = await embedImageWithBudget(buffer, mimeType, inlineBudget);
    if (clipResult === "timeout") {
      void tryEnqueueClipDedupCheck(asset.id, workspaceId);
    } else if (clipResult != null) {
      const threshold = clipDedupThreshold();
      const clipMatch = await findClipNearDuplicate(
        workspaceId,
        clipResult,
        asset.id,
        threshold,
        resolvedScope
      );
      if (clipMatch) {
        possibleDuplicate = {
          assetId: clipMatch.id,
          filename: clipMatch.filename,
          capturedAt: clipMatch.capturedAt,
          createdAt: clipMatch.createdAt,
          distance: clipMatch.similarity,
          thumbUrl: `/api/v1/assets/${clipMatch.id}/url`,
          method: "clip",
          confidence: clipConfidence(clipMatch.similarity),
        };
      }
      await db
        .update(schema.assets)
        .set({ clipDedupCheckedAt: new Date() })
        .where(eq(schema.assets.id, asset.id))
        .catch((err) => {
          console.warn("[fonto] failed to stamp clipDedupCheckedAt:", err);
        });
    } else if (visionServiceConfigured()) {
      void tryEnqueueClipDedupCheck(asset.id, workspaceId);
    }
  }

  assetIngestTotal.labels({ mime_class: classifyMime(mimeType) }).inc(1);

  return { asset, deduplicated: false, possibleDuplicate };
}

/**
 * Recursively replace any BigInt values inside a structure with a JSON-safe
 * representation. exifr stashes raw EXIF tags into nested objects/arrays and
 * some of those (file offsets, large IFD values, certain manufacturer tags)
 * come back as BigInt — which JSON.stringify rejects with
 * "Do not know how to serialize a BigInt", crashing the whole response.
 *
 * Values that fit inside Number.MAX_SAFE_INTEGER are converted to a regular
 * number so consumers don't have to parse strings for the common case; the
 * giant ones (rare, but real) are stringified to preserve precision.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value)) return value.toString("base64");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

/**
 * JSON-safe asset serializer. Converts the native BigInt phash to a string
 * representation of the canonical UNSIGNED 64-bit value (regardless of how
 * Postgres stored it as a signed int8 — see lib/perceptual.ts). Also walks
 * any nested fields (notably `exif`) to scrub embedded BigInts before they
 * reach JSON.stringify.
 */
export function serializeAsset<T extends { phash?: bigint | null }>(
  asset: T
): T & { phash: string | null } {
  return {
    ...(jsonSafe(asset) as T),
    phash: asset.phash != null ? phashFromDb(BigInt(asset.phash)).toString() : null,
  };
}
