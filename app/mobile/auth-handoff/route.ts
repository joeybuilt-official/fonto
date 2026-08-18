// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0056 — mobile OIDC bridge. After the user signs in via the IdP in
// the system browser (Better Auth session cookie now set), the native app sends
// them here. We mint a PAT and deep-link it back into the app at
// /mobile/auth-callback?pat=… — the app stores it in hardware-backed storage
// exactly like a manually-pasted token. No native OAuth client needed: the
// browser ran the whole OAuth/PKCE dance.
//
// Dormant-safe: this route only ever runs when a real session exists; with no
// IdP configured the SSO button that leads here is hidden, so it's never hit.

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { createApiKey } from "@/lib/auth/api-keys";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

const MOBILE_OIDC_KEY_NAME = "mobile-oidc";

function appBase(): string {
  return (
    process.env.OIDC_REDIRECT_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    "https://myfonto.com"
  ).replace(/\/$/, "");
}

export async function GET(req: Request) {
  // CSRF hardening: this endpoint has a state-mutating side effect (mints a
  // PAT), so reject the classic embed-as-subresource flood vectors
  // (`<img src>`, cross-origin `fetch`). A legitimate hand-off is always a
  // top-level browser navigation (`Sec-Fetch-Dest: document`); only reject
  // when the header is present and says otherwise, so non-browser/native
  // clients that omit it still work.
  const fetchDest = req.headers.get("sec-fetch-dest");
  if (fetchDest && fetchDest !== "document") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const user = await getAuthUser();
  if (!user) {
    // Not signed in yet — bounce to the (mobile) login which offers SSO.
    return NextResponse.redirect(`${appBase()}/login?mobile=1`);
  }

  // Replace-in-place: revoke any prior `mobile-oidc` keys for this user before
  // minting a fresh one. Without this, every hit inserts a new row — a repeated
  // (even accidental) hand-off could flood the key table. Now at most one live
  // `mobile-oidc` key exists per user at a time.
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKeys.userId, user.id),
        eq(schema.apiKeys.name, MOBILE_OIDC_KEY_NAME),
        isNull(schema.apiKeys.revokedAt)
      )
    );

  const key = await createApiKey({
    userId: user.id,
    name: MOBILE_OIDC_KEY_NAME,
    scopes: ["read", "write"],
  });

  // Deep-link the freshly-minted PAT back into the native app. The myfonto.com
  // https intent-filter already routes /mobile/auth-callback to the app.
  return NextResponse.redirect(
    `${appBase()}/mobile/auth-callback?pat=${encodeURIComponent(key.token)}`
  );
}
