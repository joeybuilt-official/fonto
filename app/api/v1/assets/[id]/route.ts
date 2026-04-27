// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { getS3Client, assetStorageKey, assetStorageKeyLegacy } from "@/lib/r2";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { plexoPublishEvent } from "@/lib/plexo";

const LIFECYCLE_EVENTS: Record<string, string> = {
  archivable: "ext.fonto.asset.archivable",
  archived: "ext.fonto.asset.archived",
  purged: "ext.fonto.asset.purged",
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const body = (await request.json()) as {
    lifecycleState?: string;
    trash?: boolean;
    restore?: boolean;
  };

  const updates: Record<string, unknown> = {};
  let emitEvent: string | null = null;

  if (body.trash) {
    updates.lifecycleState = "trashed";
    updates.deletedAt = new Date();
  } else if (body.restore) {
    updates.lifecycleState = "active";
    updates.deletedAt = null;
  } else if (body.lifecycleState) {
    const valid = ["active", "archivable", "archived", "purged"];
    if (!valid.includes(body.lifecycleState)) {
      return NextResponse.json({ error: "Invalid lifecycleState" }, { status: 400 });
    }
    updates.lifecycleState = body.lifecycleState;
    if (body.lifecycleState === "archived") {
      updates.archivedAt = new Date();
    }
    if (body.lifecycleState === "purged") {
      updates.purgedAt = new Date();
    }
    emitEvent = LIFECYCLE_EVENTS[body.lifecycleState] ?? null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const [updated] = await db
    .update(schema.assets)
    .set(updates)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .returning();

  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (emitEvent) {
    void plexoPublishEvent(emitEvent, {
      assetId: id,
      filename: updated.filename,
      mimeType: updated.mimeType,
      lifecycleState: updated.lifecycleState,
    });
  }

  return NextResponse.json({ asset: updated });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);
  const bucket = process.env.R2_BUCKET!;

  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // Try legacy key path for assets uploaded before the fonto/ prefix migration
    try {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: legacyKey }));
    } catch (err) {
      console.error("[fonto] R2 delete failed for both key paths, proceeding with DB delete:", err);
    }
  }

  await db
    .delete(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)));

  void plexoPublishEvent("ext.fonto.asset.purged", {
    assetId: id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    reason: "hard-delete",
  });

  return NextResponse.json({ deleted: true });
}
