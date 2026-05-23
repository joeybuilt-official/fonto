// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Per-IP sliding-window rate limit for the public share-resolve route.
// Implemented against the existing Valkey instance (shared with BullMQ).
//
// Knobs: 30 requests per rolling 60s per ipHash. Keys auto-expire after the
// window so abandoned IPs don't accrete in Valkey.
//
// On Redis/Valkey errors we fail-OPEN (allow the request) rather than
// fail-closed — the rate limit is a defence-in-depth measure, not the only
// thing protecting the route. Logging the error is the caller's job.

import { getRedisConnection } from "@/lib/queue/connection";

export const SHARE_LINK_RATE_LIMIT_MAX = 30;
export const SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function checkShareLinkRateLimit(ipHash: string): Promise<RateLimitResult> {
  if (!ipHash) {
    // No IP info → don't bother throttling (would punish all anonymous clients
    // sharing the same proxy with no signal).
    return { allowed: true, remaining: SHARE_LINK_RATE_LIMIT_MAX, resetSeconds: 0 };
  }
  const redis = getRedisConnection();
  const key = `sharelink:rate:${ipHash}`;
  try {
    // Atomic: INCR then conditionally EXPIRE on the first hit so the TTL only
    // starts when the window begins.
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS);
    }
    const ttl = count === 1 ? SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS : await redis.ttl(key);
    return {
      allowed: count <= SHARE_LINK_RATE_LIMIT_MAX,
      remaining: Math.max(0, SHARE_LINK_RATE_LIMIT_MAX - count),
      resetSeconds: ttl < 0 ? SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS : ttl,
    };
  } catch {
    return { allowed: true, remaining: SHARE_LINK_RATE_LIMIT_MAX, resetSeconds: 0 };
  }
}
