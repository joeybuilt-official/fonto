// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — POST /api/v1/imports/google-drive
//
// Body: { fileIds: string[] }. For each selected Drive file id, fetch its
// metadata (name/mimeType), download the bytes server-side (alt=media), and run
// it through createAssetRow (SHA-256 dedup + processing enqueue). Resilient:
// one file's failure does not abort the batch — each outcome is bucketed into
// imported / skipped (dedup) / failed[{id,error}]. Google-native docs
// (application/vnd.google-apps.*) are not downloadable as media and are bucketed
// into failed with a clear error rather than silently dropped.
//
// The batch is bounded (MAX_IDS) so a single synchronous request can't be asked
// to pull thousands of files inline. A rejected token (ReconnectRequiredError)
// stops the batch early and returns needsReconnect with partial progress.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import {
  googleApiFetch,
  ReconnectRequiredError,
} from "@/lib/integrations/google";

// Per-request ceiling. Keeps the inline (non-queued) importer bounded.
const MAX_IDS = 100;

interface DriveMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: { fileIds?: unknown; workspaceId?: unknown };
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

  const fileIds = Array.isArray(body.fileIds)
    ? body.fileIds.filter((f): f is string => typeof f === "string" && f.length > 0)
    : null;
  if (!fileIds || fileIds.length === 0) {
    return NextResponse.json(
      { error: "fileIds must be a non-empty string array" },
      { status: 400 }
    );
  }
  if (fileIds.length > MAX_IDS) {
    return NextResponse.json(
      {
        error: "too_many_ids",
        message: `At most ${MAX_IDS} files per request; got ${fileIds.length}. Split the selection.`,
        max: MAX_IDS,
      },
      { status: 400 }
    );
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

  let imported = 0;
  let skipped = 0;
  const failed: Array<{ id: string; error: string }> = [];
  let needsReconnect = false;

  for (const id of fileIds) {
    try {
      // 1. Metadata (name + mimeType) — needed for the asset row + native-doc guard.
      const metaUrl = new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`
      );
      metaUrl.searchParams.set("fields", "id,name,mimeType,size");
      metaUrl.searchParams.set("supportsAllDrives", "true");
      const metaRes = await googleApiFetch(integration, metaUrl.toString());
      if (!metaRes.ok) {
        failed.push({ id, error: `metadata_failed_${metaRes.status}` });
        continue;
      }
      const meta = (await metaRes.json()) as DriveMeta;

      // Google-native docs (Docs/Sheets/Slides/folders) can't be downloaded as
      // media; they require an export with a chosen format. Out of scope here.
      if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
        failed.push({ id, error: "google_native_doc_not_downloadable" });
        continue;
      }

      // 2. Download bytes.
      const mediaUrl = new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`
      );
      mediaUrl.searchParams.set("alt", "media");
      mediaUrl.searchParams.set("supportsAllDrives", "true");
      const mediaRes = await googleApiFetch(integration, mediaUrl.toString());
      if (!mediaRes.ok) {
        failed.push({ id, error: `download_failed_${mediaRes.status}` });
        continue;
      }
      const buffer = Buffer.from(await mediaRes.arrayBuffer());

      const result = await createAssetRow({
        workspaceId: workspace.id,
        userId: user.id,
        userEmail: user.email ?? null,
        filename: meta.name,
        mimeType:
          meta.mimeType ||
          mediaRes.headers.get("content-type")?.split(";")[0].trim() ||
          "application/octet-stream",
        sizeBytes: buffer.length,
        buffer,
        source: "google-drive",
      });
      if (result.deduplicated) {
        skipped += 1;
      } else {
        imported += 1;
      }
    } catch (err) {
      // A rejected token is global (not per-file) — stop the batch, report the
      // partial progress, and signal the reconnect need.
      if (err instanceof ReconnectRequiredError) {
        needsReconnect = true;
        failed.push({ id, error: "needs_reconnect" });
        break;
      }
      failed.push({ id, error: err instanceof Error ? err.message : "import_failed" });
    }
  }

  return NextResponse.json({
    imported,
    skipped,
    failed,
    total: fileIds.length,
    ...(needsReconnect ? { needsReconnect: true } : {}),
  });
}
