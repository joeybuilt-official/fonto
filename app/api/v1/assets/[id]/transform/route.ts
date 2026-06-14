// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Task #32 — non-destructive (rotate-in-place) and destructive (crop / rotate-
// as-new) image transforms.
//
// POST /api/v1/assets/:id/transform
//
// Body (JSON):
//   {
//     rotate?: 90 | 180 | 270 | -90,                       // degrees CW
//     crop?:   { x: number, y: number, w: number, h: number }, // 0..1 normalised
//     asNew?:  boolean                                      // see rules below
//   }
//
// Rules (rejected with 400 otherwise):
//   - Exactly one of `rotate` or `crop` is set.
//   - `crop` always forces `asNew=true` — the original pixels are gone.
//   - `rotate` defaults `asNew=false` (lossless re-encode replaces the original).
//
// Auth: better-auth session, then a workspace gate at the `editor` role.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { enqueueAssetProcessing, serializeAsset } from "@/lib/assets/createAssetRow";
import { nextSeq } from "@/lib/db/seq";
import { isScope } from "@/lib/scope";

const RotateSchema = z.union([
  z.literal(90),
  z.literal(180),
  z.literal(270),
  z.literal(-90),
]);

const CropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const BodySchema = z.object({
  rotate: RotateSchema.optional(),
  crop: CropSchema.optional(),
  asNew: z.boolean().optional(),
});

type Bbox = { x: number; y: number; w: number; h: number };

/**
 * Rotate a normalised bbox (0..1) clockwise by `angle` degrees. The mapping
 * preserves area and stays inside the unit square because the source image is
 * rotated by the same angle in lockstep:
 *   90  CW:  (x, y, w, h) → (1 - y - h, x,        h, w)
 *   180:    (x, y, w, h) → (1 - x - w, 1 - y - h, w, h)
 *   270 CW: (x, y, w, h) → (y,         1 - x - w, h, w)
 */
function rotateBbox(bbox: Bbox, angle: 90 | 180 | 270): Bbox {
  if (angle === 90) return { x: 1 - bbox.y - bbox.h, y: bbox.x, w: bbox.h, h: bbox.w };
  if (angle === 180) return { x: 1 - bbox.x - bbox.w, y: 1 - bbox.y - bbox.h, w: bbox.w, h: bbox.h };
  return { x: bbox.y, y: 1 - bbox.x - bbox.w, w: bbox.h, h: bbox.w };
}

/** Normalise the user's rotate input to a positive 90/180/270 multiple. */
function normalizeRotate(deg: 90 | 180 | 270 | -90): 90 | 180 | 270 {
  return deg === -90 ? 270 : deg;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid request body", details: err instanceof z.ZodError ? err.flatten() : undefined },
      { status: 400 }
    );
  }

  const hasRotate = body.rotate !== undefined;
  const hasCrop = body.crop !== undefined;
  if (hasRotate === hasCrop) {
    return NextResponse.json(
      { error: "Exactly one of `rotate` or `crop` must be set" },
      { status: 400 }
    );
  }

  // crop is destructive → force asNew. rotate defaults to in-place.
  const asNew = hasCrop ? true : (body.asNew ?? false);

  // Workspace gate via membership.
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  if (!asset.mimeType.startsWith("image/")) {
    return NextResponse.json({ error: "Asset is not an image" }, { status: 400 });
  }

  // Download the original via the storage facade (R2 today; backend-agnostic
  // tomorrow).
  const originalKey = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  let originalBuf: Buffer;
  try {
    originalBuf = await storage().getBuffer(originalKey);
  } catch (err) {
    console.error("[fonto] transform: original fetch failed:", err);
    return NextResponse.json({ error: "Original missing" }, { status: 410 });
  }

  // ── in-place rotate ──────────────────────────────────────────────────────
  if (hasRotate && !asNew) {
    const angle = normalizeRotate(body.rotate!);
    const pipeline = sharp(originalBuf, { failOn: "none" }).rotate(angle);
    const { data: rotatedBuf, info } = await pipeline.toBuffer({ resolveWithObject: true });

    await storage().put(originalKey, rotatedBuf, {
      contentType: asset.mimeType,
      contentLength: rotatedBuf.length,
    });

    // Rotate every stored face bbox in lockstep. 90/270 swap w/h.
    const faces = await db
      .select({ id: schema.faceInstances.id, bbox: schema.faceInstances.bbox })
      .from(schema.faceInstances)
      .where(eq(schema.faceInstances.assetId, asset.id));

    for (const f of faces) {
      const b = f.bbox as Partial<Bbox> | null;
      if (
        !b ||
        typeof b.x !== "number" ||
        typeof b.y !== "number" ||
        typeof b.w !== "number" ||
        typeof b.h !== "number"
      ) {
        continue;
      }
      const rotated = rotateBbox({ x: b.x, y: b.y, w: b.w, h: b.h }, angle);
      await db
        .update(schema.faceInstances)
        .set({ bbox: rotated })
        .where(eq(schema.faceInstances.id, f.id));
    }

    const newSeq = await nextSeq(asset.workspaceId, "asset");
    const [updated] = await db
      .update(schema.assets)
      .set({
        widthPx: info.width,
        heightPx: info.height,
        sizeBytes: rotatedBuf.length,
        // Strip the EXIF Orientation tag — sharp.rotate(angle) writes pixels in
        // the requested orientation, so any stored tag would double-rotate the
        // image on display.
        orientation: 1,
        // Derivatives + face crops are now stale; the worker regenerates them.
        thumbnailKey: null,
        previewKey: null,
        thumbnailGeneratedAt: null,
        processingState: "captured",
        updatedAt: new Date(),
        seq: newSeq,
      })
      .where(eq(schema.assets.id, asset.id))
      .returning();

    // Adjust workspace usage by the byte delta (fire-and-forget; reconcile
    // corrects drift).
    const delta = rotatedBuf.length - asset.sizeBytes;
    if (delta !== 0) {
      void db
        .update(schema.workspaces)
        .set({
          usageBytes: sql`GREATEST(0, ${schema.workspaces.usageBytes} + ${delta})`,
        })
        .where(eq(schema.workspaces.id, asset.workspaceId));
    }

    // Re-enqueue the full recognition pipeline so thumbs/preview/CLIP/faces all
    // catch up with the new pixels.
    await enqueueAssetProcessing({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      userId: user.id,
      userEmail: user.email ?? null,
      filename: asset.filename,
      mimeType: asset.mimeType,
    });

    return NextResponse.json({
      assetId: asset.id,
      action: "rotated-in-place",
      width: info.width,
      height: info.height,
      asset: serializeAsset(updated),
    });
  }

  // ── save-as-new (crop, or rotate-as-new) ────────────────────────────────
  let pipeline = sharp(originalBuf, { failOn: "none" });
  let action: "cropped-as-new" | "rotated-as-new";
  let derivedDescription: string;

  if (hasRotate) {
    const angle = normalizeRotate(body.rotate!);
    pipeline = pipeline.rotate(angle);
    action = "rotated-as-new";
    derivedDescription = `Rotated from ${asset.filename}`;
  } else {
    // Resolve normalised crop → integer pixel rect. Probe metadata first so we
    // know the canvas size sharp will see *after* the EXIF auto-rotate (we
    // don't pre-rotate for crop, so use the raw dimensions sharp reports).
    const meta = await sharp(originalBuf, { failOn: "none" }).metadata();
    const srcW = meta.width;
    const srcH = meta.height;
    if (!srcW || !srcH) {
      return NextResponse.json({ error: "Could not determine source dimensions" }, { status: 500 });
    }
    const c = body.crop!;
    const left = Math.max(0, Math.round(c.x * srcW));
    const top = Math.max(0, Math.round(c.y * srcH));
    const width = Math.min(srcW - left, Math.max(1, Math.round(c.w * srcW)));
    const height = Math.min(srcH - top, Math.max(1, Math.round(c.h * srcH)));
    pipeline = pipeline.extract({ left, top, width, height });
    action = "cropped-as-new";
    derivedDescription = `Cropped from ${asset.filename}`;
  }

  const { data: outBuf, info } = await pipeline.toBuffer({ resolveWithObject: true });

  // Insert the new asset row. Match the createAssetRow shape (active +
  // captured) and carry the source asset's organisational metadata so the
  // derivative shows up next to its origin in the library.
  const newId = randomUUID();
  const newFilename = derivedFilename(asset.filename, action);
  const assetSeq = await nextSeq(asset.workspaceId, "asset");

  const [inserted] = await db
    .insert(schema.assets)
    .values({
      id: newId,
      workspaceId: asset.workspaceId,
      filename: newFilename,
      mimeType: asset.mimeType,
      sizeBytes: outBuf.length,
      // sha256 is set to a content hash — the worker pipeline normally computes
      // this at ingest; here we compute it inline so the column is honest +
      // dedup queries that hit this row don't break the NOT NULL contract.
      sha256: createHash("sha256").update(outBuf).digest("hex"),
      seq: assetSeq,
      syncState: "synced",
      processingState: "captured",
      lifecycleState: "active",
      source: "transform",
      description: derivedDescription,
      // Preserve scope + shoot context so the derivative isn't homeless.
      scope: isScope(asset.scope) ? asset.scope : "PERSONAL",
      shootId: asset.shootId ?? null,
      shootStage: asset.shootStage ?? null,
      // Carry the directory + capture date so the derivative co-locates with
      // its origin in folder browses + the timeline.
      directoryPath: asset.directoryPath ?? null,
      capturedAt: asset.capturedAt ?? null,
      widthPx: info.width,
      heightPx: info.height,
      // Reset EXIF orientation tag — sharp emitted pixels in display
      // orientation, no tag rotation needed.
      orientation: 1,
      ocrState: "pending",
      kind: asset.kind ?? null,
      derivedFromAssetId: asset.id,
    })
    .returning();

  // Upload transformed bytes to the new asset's key.
  const newKey = assetStorageKey(asset.workspaceId, newId, newFilename);
  await storage().put(newKey, outBuf, {
    contentType: asset.mimeType,
    contentLength: outBuf.length,
  });

  // Workspace usage bookkeeping.
  void db
    .update(schema.workspaces)
    .set({ usageBytes: sql`${schema.workspaces.usageBytes} + ${outBuf.length}` })
    .where(eq(schema.workspaces.id, asset.workspaceId));

  // Full recognition pipeline for the new asset.
  await enqueueAssetProcessing({
    assetId: newId,
    workspaceId: asset.workspaceId,
    userId: user.id,
    userEmail: user.email ?? null,
    filename: newFilename,
    mimeType: asset.mimeType,
  });

  return NextResponse.json({
    assetId: newId,
    action,
    width: info.width,
    height: info.height,
    asset: serializeAsset(inserted),
  });
}

/** Derive a sensible filename for a transformed copy. */
function derivedFilename(
  src: string,
  action: "cropped-as-new" | "rotated-as-new"
): string {
  const dot = src.lastIndexOf(".");
  const base = dot > 0 ? src.slice(0, dot) : src;
  const ext = dot > 0 ? src.slice(dot) : "";
  const suffix = action === "cropped-as-new" ? "cropped" : "rotated";
  return `${base} (${suffix})${ext}`;
}

