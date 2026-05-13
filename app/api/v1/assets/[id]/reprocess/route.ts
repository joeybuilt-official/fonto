// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import {
  plexoAvailable,
  plexoEnsureWorkspace,
  plexoClassifyAsset,
  plexoDescribeImage,
} from "@/lib/plexo";

export async function POST(
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
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Reset to captured
  await db
    .update(schema.assets)
    .set({ processingState: "captured", classification: null, description: null })
    .where(eq(schema.assets.id, id));

  // Fire-and-forget reprocess
  (async () => {
    try {
      await db
        .update(schema.assets)
        .set({ processingState: "classified" })
        .where(eq(schema.assets.id, id));

      let classification: string;
      let description: string | null = null;

      if (plexoAvailable()) {
        const wid = await plexoEnsureWorkspace(user.id, user.email);
        classification = await plexoClassifyAsset(
          wid,
          asset.filename,
          asset.mimeType,
          asset.extractedText ?? undefined
        );
        if (asset.mimeType.startsWith("image/")) {
          description = await plexoDescribeImage(wid, asset.filename, asset.mimeType);
        }
      } else {
        classification = asset.mimeType.startsWith("image/") ? "photo" : "document";
      }

      await db
        .update(schema.assets)
        .set({ processingState: "ready", classification, description })
        .where(eq(schema.assets.id, id));
    } catch (err) {
      console.error("reprocess error:", err);
      await db
        .update(schema.assets)
        .set({ processingState: "captured" })
        .where(eq(schema.assets.id, id));
    }
  })().catch(console.error);

  return NextResponse.json({ queued: true });
}
