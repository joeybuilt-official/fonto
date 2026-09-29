// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Inbound service-key authentication for Fonto's PUBLISHED API surface.
 *
 * Fonto exposes an app-owned HTTP API (`/api/peer/v1/*`) for peers and agents.
 * It authenticates a bearer service key held by the CALLER; Fonto never calls a
 * peer to validate one, and never holds a credential on another app's behalf.
 *
 * Two key names are accepted so a rotation needs no coordinated deploy:
 *   FONTO_SERVICE_KEY       — the active inbound key
 *   FONTO_SERVICE_KEY_V2    — optional second key, accepted in parallel
 *
 * An unconfigured key means the peer surface returns 503 FEATURE_DISABLED (a
 * configuration state, not an outage) — and, critically, that surface is
 * OPTIONAL: no core Fonto flow depends on it being reachable or configured.
 */
import { timingSafeEqual } from "node:crypto";

export interface PeerAuthResult {
  ok: boolean;
  /** Present when ok=false, for the transport layer. */
  status?: number;
  code?: string;
  message?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The inbound keys this deployment accepts, ignoring unset/blank entries. */
function acceptedKeys(): string[] {
  return [process.env.FONTO_SERVICE_KEY, process.env.FONTO_SERVICE_KEY_V2]
    .map((k) => (k ?? "").trim())
    .filter((k) => k.length > 0);
}

/** True when this deployment accepts inbound peer calls at all. */
export function isPeerSurfaceConfigured(): boolean {
  return acceptedKeys().length > 0;
}

/**
 * Validate a request's bearer token against the accepted inbound keys.
 * Never throws; the caller decides the response.
 */
export function authorizeServiceKey(request: Request): PeerAuthResult {
  const keys = acceptedKeys();
  if (keys.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "FEATURE_DISABLED",
      message: "The peer API is not enabled on this deployment.",
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) {
    return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Missing bearer token" };
  }
  // Compare against every accepted key without early exit so a rotation's two
  // keys cost the same as one.
  const valid = keys.reduce((acc, key) => safeEqual(token, key) || acc, false);
  if (!valid) {
    return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Invalid service key" };
  }
  return { ok: true };
}
