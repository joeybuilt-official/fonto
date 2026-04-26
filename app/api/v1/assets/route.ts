import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });

  const workspaceId = workspaces[0].id;
  const { searchParams } = request.nextUrl;
  const mimeFilter = searchParams.get("mime");

  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active")
      )
    )
    .orderBy(schema.assets.createdAt);

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

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const [asset] = await db
    .insert(schema.assets)
    .values({
      workspaceId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256,
      syncState: "syncing",
      lifecycleState: "active",
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
