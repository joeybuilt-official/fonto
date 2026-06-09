// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — POST /api/v1/imports/google
//
// Kicks off a server-side Google Takeout import. Authenticates the caller,
// resolves the target workspace, inserts a `pending` import_jobs row, and
// enqueues a `media-import` BullMQ job carrying the user-selected Drive
// archive fileId. Returns { importJobId } for the UI to poll via
// GET /api/v1/imports/:id.
//
// Body: { driveFileId: string, workspaceId?: string }
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { tryEnqueueImport } from "@/lib/queue/queues";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: { driveFileId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const driveFileId =
    typeof body.driveFileId === "string" ? body.driveFileId.trim() : "";
  if (!driveFileId) {
    return NextResponse.json({ error: "driveFileId is required" }, { status: 400 });
  }

  const requestedWorkspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : null;
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const [row] = await db
    .insert(schema.importJobs)
    .values({
      workspaceId: workspace.id,
      userId: user.id,
      provider: "google-takeout",
      status: "pending",
    })
    .returning({ id: schema.importJobs.id });

  await tryEnqueueImport({
    importJobId: row.id,
    workspaceId: workspace.id,
    userId: user.id,
    provider: "google-takeout",
    driveFileId,
  });

  return NextResponse.json({ importJobId: row.id }, { status: 202 });
}
