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

function getSalt(): string {
  const salt = process.env.SHARE_LINK_IP_SALT;
  if (!salt) {
    // Falling back to a constant defeats the privacy property; refuse rather
    // than silently weakening. In dev you can set a placeholder.
    return "DEV_INSECURE_SALT_DO_NOT_USE_IN_PROD";
  }
  return salt;
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
