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
import { getAuthUser } from "@/lib/auth/server";
import { createApiKey } from "@/lib/auth/api-keys";

export const dynamic = "force-dynamic";

function appBase(): string {
  return (
    process.env.OIDC_REDIRECT_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    "https://myfonto.com"
  ).replace(/\/$/, "");
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    // Not signed in yet — bounce to the (mobile) login which offers SSO.
    return NextResponse.redirect(`${appBase()}/login?mobile=1`);
  }

  const key = await createApiKey({
    userId: user.id,
    name: "mobile-oidc",
    scopes: ["read", "write"],
  });

  // Deep-link the freshly-minted PAT back into the native app. The myfonto.com
  // https intent-filter already routes /mobile/auth-callback to the app.
  return NextResponse.redirect(
    `${appBase()}/mobile/auth-callback?pat=${encodeURIComponent(key.token)}`
  );
}
