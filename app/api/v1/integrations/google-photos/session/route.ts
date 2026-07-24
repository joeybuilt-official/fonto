// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — Google Photos Picker session.
//
//   POST /api/v1/integrations/google-photos/session
//     Create a picker session at Google. Returns { sessionId, pickerUri,
//     pollIntervalMs }. The browser opens `pickerUri` in a new tab; the user
//     picks photos in Google's own UI, then returns.
//
//   GET /api/v1/integrations/google-photos/session?sessionId=...
//     Poll the session. Returns { mediaItemsSet } — true once the user has
//     finished picking, which is the cue to enable "Import selected".
//
// Server-proxied: every Google call goes through `googleApiFetch`, so the
// browser never talks to the Picker API directly. A revoked/expired refresh
// token surfaces as { needsReconnect: true } so the UI can prompt a reconnect.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import {
  googleApiFetch,
  ReconnectRequiredError,
} from "@/lib/integrations/google";

const SESSIONS_URL = "https://photospicker.googleapis.com/v1/sessions";

type IntegrationRow = typeof schema.integrations.$inferSelect;

/** Parse a protobuf duration string ("5s", "1.5s") to milliseconds. */
function durationToMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== "string") return fallbackMs;
  const m = value.match(/^([0-9.]+)s$/);
  if (!m) return fallbackMs;
  const seconds = Number.parseFloat(m[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : fallbackMs;
}

/**
 * Resolve the caller's active Google integration row (workspace-scoped).
 * Returns a NextResponse on any failure (unauth / no workspace / not
 * connected), else the full integration row to pass to googleApiFetch.
 */
async function resolveGoogleIntegration(
  request: NextRequest
): Promise<{ integration: IntegrationRow } | { error: NextResponse }> {
  const user = await getAuthUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return { error: NextResponse.json({ error: "No workspace" }, { status: 404 }) };
  }

  const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId");
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return {
      error: NextResponse.json({ error: "Workspace not found" }, { status: 404 }),
    };
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
    return {
      error: NextResponse.json(
        { error: "not_connected", needsReconnect: true },
        { status: 404 }
      ),
    };
  }
  if (integration.status !== "active") {
    return {
      error: NextResponse.json(
        { error: "needs_reconnect", needsReconnect: true },
        { status: 409 }
      ),
    };
  }

  return { integration };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await resolveGoogleIntegration(request);
  if ("error" in resolved) return resolved.error;

  try {
    // The Picker API creates a session from an empty request body; the user's
    // selection is captured in Google's own UI at `pickerUri`.
    const res = await googleApiFetch(resolved.integration, SESSIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "session_create_failed", status: res.status, detail },
        { status: 502 }
      );
    }
    const session = (await res.json()) as {
      id?: string;
      pickerUri?: string;
      pollingConfig?: { pollInterval?: string };
    };
    if (!session.id || !session.pickerUri) {
      return NextResponse.json(
        { error: "session_create_failed", detail: "missing id/pickerUri" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      sessionId: session.id,
      pickerUri: session.pickerUri,
      pollIntervalMs: durationToMs(session.pollingConfig?.pollInterval, 3000),
    });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return NextResponse.json(
        { error: "needs_reconnect", needsReconnect: true },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "session_create_failed" },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const resolved = await resolveGoogleIntegration(request);
  if ("error" in resolved) return resolved.error;

  try {
    const res = await googleApiFetch(
      resolved.integration,
      `${SESSIONS_URL}/${encodeURIComponent(sessionId)}`
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "session_poll_failed", status: res.status, detail },
        { status: 502 }
      );
    }
    const session = (await res.json()) as {
      mediaItemsSet?: boolean;
      pollingConfig?: { pollInterval?: string };
    };
    return NextResponse.json({
      mediaItemsSet: Boolean(session.mediaItemsSet),
      pollIntervalMs: durationToMs(session.pollingConfig?.pollInterval, 3000),
    });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return NextResponse.json(
        { error: "needs_reconnect", needsReconnect: true },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "session_poll_failed" },
      { status: 502 }
    );
  }
}
