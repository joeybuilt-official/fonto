// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — GET /api/v1/integrations/nextcloud/status
//
// Reports whether the caller's workspace has an active Nextcloud connection.
// Returns { connected, baseUrl? }. The app password is NEVER returned — only
// the (non-secret) instance base URL, for UI display.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { loadNextcloudCredentials } from "@/lib/integrations/nextcloud";

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  const creds = await loadNextcloudCredentials(workspace.id, user.id);
  if (!creds) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({ connected: true, baseUrl: creds.baseUrl });
}
