// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Mobile sign-in bridge. After the user signs in on the web /login?mobile=1 by
// ANY method — email+password, passkey, one-time link, or SSO — the browser has
// a Better Auth session cookie and lands here. We mint a PAT and deep-link it
// back into the native app at /mobile/auth-callback?pat=… — the app stores it
// in hardware-backed storage exactly like a manually-pasted token. No native
// OAuth client needed; the browser ran whatever auth flow was used.
//
// Safe by construction: this route only mints a token when a real session
// exists (getAuthUser); otherwise it bounces to /login?mobile=1.

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
    name: "mobile",
    scopes: ["read", "write"],
  });

  // Deep-link the freshly-minted PAT back into the native app. The myfonto.com
  // https intent-filter already routes /mobile/auth-callback to the app.
  return NextResponse.redirect(
    `${appBase()}/mobile/auth-callback?pat=${encodeURIComponent(key.token)}`
  );
}
