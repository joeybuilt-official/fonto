// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5 (media import) — POST /api/v1/integrations/google/mobile-connect
//
// The mobile bridge for the server-side Google integration. The web flow uses a
// browser redirect (auth → consent → callback); a native app can't, so the
// Flutter client uses google_sign_in's offline-access flow to obtain a
// `serverAuthCode` on-device, then POSTs it here. We exchange it for a refresh
// token and UPSERT the encrypted `integrations` row exactly like the web
// callback (app/api/v1/integrations/google/callback/route.ts) — leaving the rest
// of the import pipeline (Takeout job, token refresh, reconnect) identical
// across web and mobile.
//
// Auth: PAT (Authorization: Bearer fonto_pat_...) or session via getAuthUser —
// this is a real API client call, unlike the redirect callback whose trust came
// from the signed `state`.
//
// Body: { serverAuthCode: string, workspaceId?: string }
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { exchangeServerAuthCode } from "@/lib/integrations/google";
import { encryptToken } from "@/lib/integrations/tokenCrypto";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  let body: { serverAuthCode?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const serverAuthCode =
    typeof body.serverAuthCode === "string" ? body.serverAuthCode.trim() : "";
  if (!serverAuthCode) {
    return NextResponse.json(
      { error: "serverAuthCode is required" },
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

  let refreshToken: string | null;
  let scope: string | null;
  try {
    ({ refreshToken, scope } = await exchangeServerAuthCode(serverAuthCode));
  } catch {
    return NextResponse.json({ error: "exchange_failed" }, { status: 502 });
  }

  // No refresh token means we can't mint future access tokens. The mobile flow
  // must request offline access (server_client_id + access_type implied by
  // serverAuthCode); fail loudly rather than store a dead integration.
  if (!refreshToken) {
    return NextResponse.json({ error: "no_refresh_token" }, { status: 400 });
  }

  const encryptedRefreshToken = encryptToken(refreshToken);
  const now = new Date();

  // UPSERT on (workspaceId, userId, provider) — same explicit lookup-then-write
  // as the web callback (no unique constraint on that triple).
  const existing = await db
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, workspace.id),
        eq(schema.integrations.userId, user.id),
        eq(schema.integrations.provider, "google")
      )
    )
    .limit(1);

  if (existing.length) {
    await db
      .update(schema.integrations)
      .set({
        encryptedRefreshToken,
        grantedScopes: scope,
        status: "active",
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.integrations.id, existing[0].id));
  } else {
    await db.insert(schema.integrations).values({
      workspaceId: workspace.id,
      userId: user.id,
      provider: "google",
      encryptedRefreshToken,
      grantedScopes: scope,
      status: "active",
    });
  }

  return NextResponse.json({ provider: "google", status: "active" });
}
