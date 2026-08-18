// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — POST /api/v1/integrations/nextcloud/connect
//
// Connects the caller's Nextcloud instance. Body: { baseUrl, username,
// appPassword }. We PROPFIND the WebDAV root server-side to verify the
// credentials (the browser never talks to Nextcloud directly), then encrypt +
// upsert the `integrations` row (provider='nextcloud', status='active'). Bad
// credentials → 400; unreachable host → 400 with the reason.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import {
  saveNextcloudCredentials,
  verifyConnection,
  type NextcloudCredentials,
} from "@/lib/integrations/nextcloud";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: {
    baseUrl?: unknown;
    username?: unknown;
    appPassword?: unknown;
    workspaceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const appPassword =
    typeof body.appPassword === "string" ? body.appPassword : "";

  if (!baseUrl || !username || !appPassword) {
    return NextResponse.json(
      { error: "baseUrl, username and appPassword are required" },
      { status: 400 }
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json(
      { error: "baseUrl must start with http:// or https://" },
      { status: 400 }
    );
  }

  const requestedWorkspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : null;
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const creds: NextcloudCredentials = { baseUrl, username, appPassword };

  const check = await verifyConnection(creds);
  if (!check.ok) {
    // Bad password or unreachable host — both are a caller-fixable 400.
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  await saveNextcloudCredentials(workspace.id, user.id, creds);

  return NextResponse.json({ provider: "nextcloud", status: "active" });
}
