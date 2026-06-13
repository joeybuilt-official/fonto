// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Bulk user-triggered re-scan: re-runs the full recognition pipeline
// (classify + describe + OCR + CLIP + vision labels + faces) across every
// matching asset in the caller's workspace. Editor+ only — this enqueues a
// burst of work against the local plexo-vision/Ollama box.
//
//   POST /api/v1/workspace/reprocess
//     Body: { scope?: 'all' | 'images' | 'failed' }   (default 'all')
//       all    — every non-deleted asset
//       images — non-deleted image/* assets only
//       failed — assets whose processing failed (or is stuck mid-flight)
//     Returns { queued: <count> }.
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, isNull, like, ne } from "drizzle-orm";
import { enqueueAssetProcessing } from "@/lib/assets/createAssetRow";

type Scope = "all" | "images" | "failed";
const SCOPES: readonly Scope[] = ["all", "images", "failed"];

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { scope?: unknown } | null;
  const scope: Scope =
    typeof body?.scope === "string" && (SCOPES as readonly string[]).includes(body.scope)
      ? (body.scope as Scope)
      : "all";

  const conditions = [
    eq(schema.assets.workspaceId, workspaceId),
    isNull(schema.assets.deletedAt),
    // ADR 0008 — scope default
    eq(schema.assets.scope, "PERSONAL"),
  ];
  if (scope === "images") {
    conditions.push(like(schema.assets.mimeType, "image/%"));
  } else if (scope === "failed") {
    // Failed outright, or wedged in a non-terminal state (never reached ready).
    conditions.push(ne(schema.assets.processingState, "ready"));
  }

  const rows = await db
    .select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
    })
    .from(schema.assets)
    .where(and(...conditions));

  if (rows.length === 0) return NextResponse.json({ queued: 0 });

  // Reset all matched rows to the pre-processing state in one statement so
  // they surface in the "processing" count immediately.
  await db
    .update(schema.assets)
    .set({ processingState: "captured" })
    .where(and(...conditions));

  for (const row of rows) {
    await enqueueAssetProcessing({
      assetId: row.id,
      workspaceId,
      userId: user.id,
      userEmail: user.email,
      filename: row.filename,
      mimeType: row.mimeType,
    });
  }

  return NextResponse.json({ queued: rows.length });
}
