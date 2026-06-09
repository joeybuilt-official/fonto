// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — GET /api/v1/integrations/google/auth
//
// Starts the server-side Google OAuth flow. Authenticates the caller, resolves
// the target workspace (mirrors GET /api/v1/folders), mints a signed `state`
// tying the round-trip to this user+workspace, and 302-redirects to Google's
// consent screen. The callback completes the exchange + token storage.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { buildConsentUrl } from "@/lib/integrations/google";
import { signState } from "@/lib/integrations/oauthState";

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

  const state = signState({ userId: user.id, workspaceId: workspace.id });
  const consentUrl = buildConsentUrl(state);

  return NextResponse.redirect(consentUrl);
}
