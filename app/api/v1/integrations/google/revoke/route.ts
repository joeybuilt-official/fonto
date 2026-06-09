// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — POST /api/v1/integrations/google/revoke
//
// Disconnects the caller's Google integration: best-effort revokes the refresh
// token at Google, then flips the local row to 'revoked' and nulls the stored
// (encrypted) token. Session-authed (mirrors GET /api/v1/integrations/google/auth).
// The local row flip is the source of truth — a failed Google revoke does not
// fail the request, since the token is removed locally regardless.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { revokeToken } from "@/lib/integrations/google";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  const { searchParams } = request.nextUrl;
  const requestedWorkspaceId = searchParams.get("workspaceId");
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const [integration] = await db
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, workspace.id),
        eq(schema.integrations.userId, user.id),
        eq(schema.integrations.provider, "google")
      )
    )
    .limit(1);

  if (!integration) {
    return NextResponse.json({ error: "Not connected" }, { status: 404 });
  }

  // Best-effort revoke at Google (advisory — never blocks the local flip).
  await revokeToken(integration.encryptedRefreshToken);

  await db
    .update(schema.integrations)
    .set({
      encryptedRefreshToken: null,
      status: "revoked",
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.integrations.id, integration.id));

  return NextResponse.json({ status: "revoked" });
}
