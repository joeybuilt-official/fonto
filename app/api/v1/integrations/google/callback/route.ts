// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — GET /api/v1/integrations/google/callback
//
// Google redirects the user here after the consent screen. We:
//   1. Handle a user-denied / error response (redirect with ?error=...).
//   2. Validate the signed `state` (CSRF + carries user+workspace).
//   3. Exchange the `code` for tokens.
//   4. Encrypt the refresh token + UPSERT the `integrations` row (active).
//   5. Redirect to /app/imports/google?connected=google.
//
// This route is reached via a browser redirect from Google, NOT an API client,
// so it does not require a Fonto session/PAT — trust is established by the
// HMAC-signed `state` we minted in the /auth route.

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { exchangeCode } from "@/lib/integrations/google";
import { verifyState } from "@/lib/integrations/oauthState";
import { encryptToken } from "@/lib/integrations/tokenCrypto";
import { publicOrigin } from "@/lib/http/publicOrigin";

/**
 * Build an absolute redirect to an /app path on the origin the BROWSER used.
 * Not `request.nextUrl.origin`: in the standalone container that is the bind
 * address (`https://0.0.0.0:3500`), which the browser cannot resolve.
 */
function appRedirect(request: NextRequest, path: string): NextResponse {
  const origin = publicOrigin(request.headers, request.nextUrl.origin);
  return NextResponse.redirect(new URL(path, origin));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  // 1. User denied consent, or Google returned an error.
  const oauthError = searchParams.get("error");
  if (oauthError) {
    return appRedirect(
      request,
      `/app/imports/google?error=${encodeURIComponent(oauthError)}`
    );
  }

  // 2. Validate state (CSRF + identity).
  const payload = verifyState(searchParams.get("state"));
  if (!payload) {
    return appRedirect(request, "/app/imports/google?error=invalid_state");
  }

  // 3. Need a code to exchange.
  const code = searchParams.get("code");
  if (!code) {
    return appRedirect(request, "/app/imports/google?error=missing_code");
  }

  // 4. Exchange + persist.
  let refreshToken: string | null;
  let scope: string | null;
  try {
    ({ refreshToken, scope } = await exchangeCode(code));
  } catch {
    return appRedirect(request, "/app/imports/google?error=exchange_failed");
  }

  // No refresh token means we can't mint future access tokens. This happens
  // when Google silently re-auths without re-consenting; `prompt=consent`
  // should prevent it, but fail loudly rather than store a dead integration.
  if (!refreshToken) {
    return appRedirect(request, "/app/imports/google?error=no_refresh_token");
  }

  const encryptedRefreshToken = encryptToken(refreshToken);
  const now = new Date();

  // UPSERT on (workspaceId, userId, provider). There's no unique constraint on
  // that triple, so do an explicit lookup-then-insert/update inside the same
  // request rather than relying on onConflict.
  const existing = await db
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, payload.workspaceId),
        eq(schema.integrations.userId, payload.userId),
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
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      provider: "google",
      encryptedRefreshToken,
      grantedScopes: scope,
      status: "active",
    });
  }

  // 5. Done.
  return appRedirect(request, "/app/imports/google?connected=google");
}
