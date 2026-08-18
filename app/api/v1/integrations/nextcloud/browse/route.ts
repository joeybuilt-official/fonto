// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — GET /api/v1/integrations/nextcloud/browse?path=
//
// Server-proxied WebDAV directory listing (the browser must NOT hit Nextcloud
// directly — CORS + credential exposure). Loads the stored credentials,
// PROPFINDs `path` (default "/") at Depth:1, and returns { entries }. A 401 from
// Nextcloud means the stored app password no longer works → 401 with
// needsReconnect:true so the UI can prompt a reconnect.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import {
  loadNextcloudCredentials,
  propfind,
  NextcloudAuthError,
} from "@/lib/integrations/nextcloud";

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
    return NextResponse.json(
      { error: "not_connected", needsReconnect: true },
      { status: 404 }
    );
  }

  const path = searchParams.get("path") || "/";

  try {
    const entries = await propfind(creds, path);
    return NextResponse.json({ entries });
  } catch (err) {
    if (err instanceof NextcloudAuthError) {
      return NextResponse.json(
        { error: "invalid_credentials", needsReconnect: true },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "browse_failed" },
      { status: 502 }
    );
  }
}
