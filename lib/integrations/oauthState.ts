// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — OAuth `state` parameter signing.
//
// The `state` round-trips through Google's consent screen and back to our
// callback. It must (a) be unforgeable (CSRF protection — only WE could have
// minted it) and (b) carry the initiating user+workspace so the callback can
// persist the integration without a separate session lookup that might race.
//
// Design: a compact, stateless, signed token (no server-side store needed):
//
//   base64url(JSON{ userId, workspaceId, nonce, issuedAt })
//     + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))
//
// The callback recomputes the HMAC (constant-time compare) and rejects expired
// tokens (10-minute TTL — a consent flow that takes longer is almost certainly
// a stale/replayed link).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes.

export interface OAuthStatePayload {
  userId: string;
  workspaceId: string;
}

interface SignedStateBody extends OAuthStatePayload {
  nonce: string;
  issuedAt: number;
}

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set — cannot sign OAuth state");
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
}

/** Mint a signed state token for the given user+workspace. */
export function signState(payload: OAuthStatePayload): string {
  const body: SignedStateBody = {
    ...payload,
    nonce: randomBytes(8).toString("hex"),
    issuedAt: Date.now(),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(body), "utf8"));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify + decode a state token. Returns the payload on success, or null if
 * the token is malformed, the signature is invalid, or it has expired.
 */
export function verifyState(token: string | null): OAuthStatePayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expected = sign(payloadB64);
  const got = Buffer.from(sigB64);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let body: SignedStateBody;
  try {
    body = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof body.issuedAt !== "number" || Date.now() - body.issuedAt > STATE_TTL_MS) {
    return null;
  }
  if (!body.userId || !body.workspaceId) return null;

  return { userId: body.userId, workspaceId: body.workspaceId };
}
