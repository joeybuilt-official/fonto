// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// mintSession — issue a real Better Auth session cookie for a user who has
// been verified out-of-band (passkey assertion, one-time legacy link). Better
// Auth has no public sign-in-by-userId API, so we create the session row via
// its internal adapter and set the same signed session-token cookie its own
// sign-in path sets, so `auth.api.getSession` recognizes it.
//
// The signed-cookie format mirrors better-call's signCookieValue (the signer
// better-auth uses): `encodeURIComponent(`${token}.${base64(HMAC-SHA256(
// secret, token))}`)`. Reproduced with WebCrypto rather than deep-importing
// better-call/dist/crypto (not in better-auth's package exports).
//
// ponytail: this is infra glue over better-auth's promise API; the surrounding
// auth routes/lib are plain async, so it stays plain async (no Effect wrapper).

import { auth } from "@/lib/auth";
import { cookies } from "next/headers";

async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Raw `token.sig` — Next's cookie jar URL-encodes on serialization; a
  // pre-encoded value would double-encode on the wire and never verify.
  return `${value}.${b64}`;
}

export async function mintSession(userId: string): Promise<void> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false);
  const token = (session as { token: string }).token;

  const cookie = ctx.authCookies.sessionToken;
  const signed = await signCookieValue(token, ctx.secret);

  // Map only the real Set-Cookie attributes onto Next's cookie API (better-auth
  // carries extra internal fields like `prefix`/`partitioned` that Next rejects).
  const a = cookie.attributes;
  const jar = await cookies();
  jar.set(cookie.name, signed, {
    maxAge: ctx.sessionConfig.expiresIn,
    httpOnly: a.httpOnly,
    path: a.path,
    secure: a.secure,
    domain: a.domain,
    sameSite:
      typeof a.sameSite === "string"
        ? (a.sameSite.toLowerCase() as "lax" | "strict" | "none")
        : a.sameSite,
  });
}
