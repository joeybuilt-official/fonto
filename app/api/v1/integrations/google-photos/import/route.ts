// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — POST /api/v1/integrations/google-photos/import
//
// Body: { sessionId: string }. Lists the media items the user picked in the
// Picker session, downloads each one server-side at full resolution, and runs
// it through createAssetRow (SHA-256 dedup + processing enqueue). Resilient:
// one item's failure does not abort the batch — each outcome buckets into
// imported / skipped (dedup) / failed[{id,error}].
//
// The batch is bounded (MAX_ITEMS) so a single synchronous request can't be
// asked to pull thousands of items inline; the picker UI naturally covers the
// "pick a few albums' worth" P0 flow. After a successful listing the session is
// best-effort deleted (its picked set is single-use).
//
// Server-proxied: every Google call — the mediaItems listing AND each byte
// download — goes through `googleApiFetch`, so the browser never talks to the
// Picker API directly.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import {
  googleApiFetch,
  ReconnectRequiredError,
} from "@/lib/integrations/google";

const PICKER_BASE = "https://photospicker.googleapis.com/v1";
// Per-request ceiling. Keeps the inline (non-queued) importer bounded.
const MAX_ITEMS = 100;

interface PickedMediaItem {
  id: string;
  type?: string;
  createTime?: string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: { sessionId?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const requestedWorkspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : null;
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

  if (!integration || !integration.encryptedRefreshToken) {
    return NextResponse.json(
      { error: "not_connected", needsReconnect: true },
      { status: 404 }
    );
  }

  try {
    // 1. List the picked media items (paginated, bounded to MAX_ITEMS).
    const items: PickedMediaItem[] = [];
    let pageToken: string | null = null;
    do {
      const url = new URL(`${PICKER_BASE}/mediaItems`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set(
        "pageSize",
        String(Math.min(100, MAX_ITEMS - items.length))
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const listRes = await googleApiFetch(integration, url.toString());
      if (!listRes.ok) {
        const detail = await listRes.text().catch(() => "");
        return NextResponse.json(
          { error: "list_failed", status: listRes.status, detail },
          { status: 502 }
        );
      }
      const page = (await listRes.json()) as {
        mediaItems?: PickedMediaItem[];
        nextPageToken?: string;
      };
      for (const it of page.mediaItems ?? []) {
        if (it.id) items.push(it);
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken && items.length < MAX_ITEMS);

    if (items.length === 0) {
      return NextResponse.json({ imported: 0, skipped: 0, failed: [], total: 0 });
    }

    // 2. Download + ingest each item. One failure never aborts the batch.
    let imported = 0;
    let skipped = 0;
    const failed: Array<{ id: string; error: string }> = [];

    for (const item of items) {
      const baseUrl = item.mediaFile?.baseUrl;
      if (!baseUrl) {
        failed.push({ id: item.id, error: "missing_base_url" });
        continue;
      }
      try {
        // Picker API download params: `=d` full-res photo, `=dv` full video.
        const suffix = item.type === "VIDEO" ? "=dv" : "=d";
        const dlRes = await googleApiFetch(integration, `${baseUrl}${suffix}`);
        if (!dlRes.ok) {
          failed.push({ id: item.id, error: `download_${dlRes.status}` });
          continue;
        }
        const buffer = Buffer.from(await dlRes.arrayBuffer());
        const result = await createAssetRow({
          workspaceId: workspace.id,
          userId: user.id,
          userEmail: user.email ?? null,
          filename: item.mediaFile?.filename ?? `${item.id}`,
          mimeType:
            item.mediaFile?.mimeType ||
            dlRes.headers.get("content-type") ||
            "application/octet-stream",
          sizeBytes: buffer.length,
          buffer,
          source: "google-photos",
        });
        if (result.deduplicated) skipped += 1;
        else imported += 1;
      } catch (err) {
        if (err instanceof ReconnectRequiredError) throw err;
        failed.push({
          id: item.id,
          error: err instanceof Error ? err.message : "import_failed",
        });
      }
    }

    // 3. Best-effort delete the (single-use) picker session; never fatal.
    try {
      await googleApiFetch(
        integration,
        `${PICKER_BASE}/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" }
      );
    } catch {
      // Session cleanup is advisory; the import result stands regardless.
    }

    return NextResponse.json({ imported, skipped, failed, total: items.length });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return NextResponse.json(
        { error: "needs_reconnect", needsReconnect: true },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "import_failed" },
      { status: 502 }
    );
  }
}
