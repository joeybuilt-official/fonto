// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Privacy: we never store raw client IPs for share-link analytics. Instead,
// each access row gets `sha256(SHARE_LINK_IP_SALT + ip)`. The salt is
// per-deploy (set in env), so hashes are not portable across instances —
// nobody can rainbow-table a leaked DB into IPs without also leaking the
// env file.

import { createHash } from "crypto";
import type { NextRequest } from "next/server";

// The dev fallback is intentionally LOUD and non-production: a constant salt
// defeats the privacy property entirely (anyone with the DB and this public
// source can recompute every ipHash). In production we throw rather than
// degrade silently — the comment above used to promise exactly that while the
// code returned the constant anyway.
const DEV_FALLBACK_SALT = "DEV_INSECURE_SALT_DO_NOT_USE_IN_PROD";
let _warned = false;

function getSalt(): string {
  const salt = process.env.SHARE_LINK_IP_SALT;
  if (salt) return salt;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SHARE_LINK_IP_SALT is not set. It is required in production: without a " +
        "per-deploy random salt, share-link access ipHash values are computed " +
        "from a constant that is public in this repository, so the /share/* " +
        "privacy guarantee (never store a recoverable client IP) is void. " +
        "Generate one with `openssl rand -hex 32` and set it. Note that " +
        "rotating it invalidates all existing ipHash analytics."
    );
  }

  if (!_warned) {
    _warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[share-links] SHARE_LINK_IP_SALT is unset — using a known-constant dev " +
        "salt. ipHash analytics are NOT private in this configuration. Set it " +
        "before deploying (openssl rand -hex 32)."
    );
  }
  return DEV_FALLBACK_SALT;
}

/**
 * Extract the client IP from the request, preferring the leftmost entry in
 * `x-forwarded-for` (the original client) over `x-real-ip` / connection IP.
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  // Next 16 doesn't expose `req.ip` in route handlers — fall back to empty.
  return "";
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(getSalt()).update(ip).digest("hex");
}
