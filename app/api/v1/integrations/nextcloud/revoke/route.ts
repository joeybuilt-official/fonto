// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — POST|DELETE /api/v1/integrations/nextcloud/revoke
//
// Disconnects the caller's Nextcloud integration: nulls the encrypted
// credential blob and flips the row to 'revoked'. Mirrors the Google revoke
// (local row is the source of truth — there is no remote token to revoke for a
// Basic-auth app password; the user rotates it in Nextcloud themselves).
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { revokeNextcloudIntegration } from "@/lib/integrations/nextcloud";

async function handle(request: NextRequest): Promise<NextResponse> {
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

  const existed = await revokeNextcloudIntegration(workspace.id, user.id);
  if (!existed) {
    return NextResponse.json({ error: "Not connected" }, { status: 404 });
  }

  return NextResponse.json({ status: "revoked" });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
