// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — GET /api/v1/integrations/google-drive/browse?folderId=
//
// Server-proxied Google Drive directory listing (the browser must NOT hit the
// Drive API directly — that would leak the access token to the client). Loads
// the stored google integration row, lists the children of `folderId` (default
// "root") via the Drive `files.list` endpoint through `googleApiFetch`, and
// returns { entries }. A rejected/absent token surfaces as 401 with
// needsReconnect:true so the UI can prompt a reconnect via the existing OAuth.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  googleApiFetch,
  ReconnectRequiredError,
} from "@/lib/integrations/google";

const FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

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

  if (!integration || !integration.encryptedRefreshToken || integration.status === "revoked") {
    return NextResponse.json(
      { error: "not_connected", needsReconnect: true },
      { status: 401 }
    );
  }

  const folderId = searchParams.get("folderId") || "root";

  // Drive query: direct children of the folder, excluding trashed items.
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name,mimeType,size,thumbnailLink),nextPageToken");
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("orderBy", "folder,name");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  try {
    const res = await googleApiFetch(integration, url.toString());
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "drive_list_failed", status: res.status, detail: text.slice(0, 200) },
        { status: 502 }
      );
    }
    const body = (await res.json()) as { files?: DriveFile[] };
    const entries = (body.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      isDir: f.mimeType === FOLDER_MIME,
      mimeType: f.mimeType,
      size: f.size ? Number.parseInt(f.size, 10) || 0 : 0,
    }));
    return NextResponse.json({ entries });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return NextResponse.json(
        { error: "needs_reconnect", needsReconnect: true },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "browse_failed" },
      { status: 502 }
    );
  }
}
