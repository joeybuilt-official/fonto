// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import {
  plexoAvailable,
  plexoEnsureWorkspace,
  plexoClassifyAsset,
  plexoDescribeImage,
  plexoPublishEvent,
  plexoStoreMemory,
  plexoSuggestTags,
} from "@/lib/plexo";

const DOCUMENT_CLASSIFICATIONS = new Set(["document", "receipt", "scan", "report", "form", "contract", "letter"]);
const DOCUMENT_TRIGGER_MIME = ["application/pdf", "text/", "image/tiff"];

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

  return NextResponse.json({ assets: filtered });
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
        return NextResponse.json({ asset: existingAsset }, { status: 200 });
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
    return NextResponse.json({ asset: duplicate, deduplicated: true }, { status: 200 });
  }

  // Extract text from text/* files immediately
  let extractedText: string | null = null;
  if (file.type.startsWith("text/") && buffer.length < 500_000) {
    extractedText = buffer.toString("utf-8").slice(0, 10_000);
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
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256,
      syncState: "syncing",
      processingState: "captured",
      lifecycleState: "active",
      source,
      extractedText,
      capturedAt: new Date(),
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

    // Fire-and-forget processing pipeline (classification, tags, memory)
    processAsset(asset.id, user.id, user.email, file.name, file.type, extractedText).catch(
      console.error
    );

    return NextResponse.json({ asset: { ...asset, syncState: "synced" } }, { status: 201 });
  } catch (err) {
    console.error("[fonto] R2 upload failed:", err);
    await db
      .update(schema.assets)
      .set({ syncState: "error" })
      .where(eq(schema.assets.id, asset.id));
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
