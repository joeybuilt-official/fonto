// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  const workspace = workspaces[0];

  const assets = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.workspaceId, workspace.id));

  const collectionsData = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.workspaceId, workspace.id));

  const exportData = {
    exportedAt: new Date().toISOString(),
    workspace: {
      id: workspace.id,
      name: workspace.name,
    },
    assets: assets.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      syncState: a.syncState,
      processingState: a.processingState,
      lifecycleState: a.lifecycleState,
      source: a.source,
      classification: a.classification,
      description: a.description,
      capturedAt: a.capturedAt?.toISOString(),
      createdAt: a.createdAt.toISOString(),
    })),
    collections: collectionsData.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      createdAt: c.createdAt.toISOString(),
    })),
  };

  const json = JSON.stringify(exportData, null, 2);

  return new NextResponse(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="fonto-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
