// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — POST /api/v1/imports/nextcloud
//
// Body: { paths: string[] }. For each selected WebDAV file path, download it
// server-side and run it through createAssetRow (SHA-256 dedup + processing
// enqueue). Resilient: one file's failure does not abort the batch — each
// outcome is bucketed into imported / skipped (dedup) / failed[{path,error}].
//
// The batch is bounded (MAX_PATHS) so a single synchronous request can't be
// asked to pull thousands of files inline. A queued/background importer (like
// the Google Takeout BullMQ job) that streams unbounded selections is the
// intended follow-up; this inline path covers the P0 "pick a few folders'
// worth" flow.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import {
  loadNextcloudCredentials,
  download,
  NextcloudAuthError,
} from "@/lib/integrations/nextcloud";

// Per-request ceiling. Keeps the inline (non-queued) importer bounded; a
// background/queued version handling larger selections is a follow-up.
const MAX_PATHS = 100;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: { paths?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedWorkspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : null;
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : null;
  if (!paths || paths.length === 0) {
    return NextResponse.json(
      { error: "paths must be a non-empty string array" },
      { status: 400 }
    );
  }
  if (paths.length > MAX_PATHS) {
    return NextResponse.json(
      {
        error: "too_many_paths",
        message: `At most ${MAX_PATHS} paths per request; got ${paths.length}. Split the selection or use the background importer.`,
        max: MAX_PATHS,
      },
      { status: 400 }
    );
  }

  const creds = await loadNextcloudCredentials(workspace.id, user.id);
  if (!creds) {
    return NextResponse.json(
      { error: "not_connected", needsReconnect: true },
      { status: 404 }
    );
  }

  let imported = 0;
  let skipped = 0;
  const failed: Array<{ path: string; error: string }> = [];

  for (const path of paths) {
    try {
      const file = await download(creds, path);
      const result = await createAssetRow({
        workspaceId: workspace.id,
        userId: user.id,
        userEmail: user.email ?? null,
        filename: file.filename,
        mimeType: file.contentType,
        sizeBytes: file.buffer.length,
        buffer: file.buffer,
        source: "nextcloud",
      });
      if (result.deduplicated) {
        skipped += 1;
      } else {
        imported += 1;
      }
    } catch (err) {
      // Credential rot mid-batch is worth surfacing distinctly, but we still
      // let the loop finish so partial progress + the reconnect signal both land.
      const error =
        err instanceof NextcloudAuthError
          ? "invalid_credentials"
          : err instanceof Error
            ? err.message
            : "import_failed";
      failed.push({ path, error });
    }
  }

  const needsReconnect = failed.some((f) => f.error === "invalid_credentials");

  return NextResponse.json({
    imported,
    skipped,
    failed,
    total: paths.length,
    ...(needsReconnect ? { needsReconnect: true } : {}),
  });
}
