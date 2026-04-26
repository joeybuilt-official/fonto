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
} from "@/lib/plexo";

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

    if (plexoAvailable()) {
      const wid = await plexoEnsureWorkspace(userId, email);
      classification = await plexoClassifyAsset(wid, filename, mimeType, extractedText ?? undefined);

      if (mimeType.startsWith("image/")) {
        description = await plexoDescribeImage(wid, filename, mimeType);
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
  } catch (err) {
    console.error("processAsset error:", err);
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

  const filtered = mimeFilter
    ? rows.filter((a) => a.mimeType.startsWith(mimeFilter))
    : rows;

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

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const source = (formData.get("source") as string | null) ?? "web-upload";

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // Extract text from text/* files immediately
  let extractedText: string | null = null;
  if (file.type.startsWith("text/") && buffer.length < 500_000) {
    extractedText = buffer.toString("utf-8").slice(0, 10_000);
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

    // Fire-and-forget processing pipeline
    processAsset(asset.id, user.id, user.email, file.name, file.type, extractedText).catch(
      console.error
    );

    return NextResponse.json({ asset: { ...asset, syncState: "synced" } }, { status: 201 });
  } catch (err) {
    console.error("R2 upload failed:", err);
    await db
      .update(schema.assets)
      .set({ syncState: "error" })
      .where(eq(schema.assets.id, asset.id));
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
