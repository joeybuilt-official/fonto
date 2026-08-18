// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Mobile auth-handoff exchange-code store.
//
// Threat model: the old hand-off deep-linked the freshly-minted PAT straight
// into the redirect URL (`/mobile/auth-callback?pat=fonto_pat_…`). URLs leak —
// browser history, `Referer` on any subresource the callback page loads, proxy
// / CDN access logs, OS deep-link routing logs. A long-lived bearer token in a
// URL is a standing credential-exposure hole.
//
// Fix (mirrors the OAuth authorization-code pattern): the redirect carries a
// short-lived, single-use, high-entropy CODE instead. The native app POSTs the
// code to /mobile/auth-exchange over TLS and receives the PAT exactly once; the
// code is atomically deleted on first read (GETDEL) and self-expires after
// EXCHANGE_CODE_TTL_SECONDS regardless. Intercepting the code buys an attacker
// a <=60s single-shot window, and redeeming it first burns it — the legit app's
// redeem then fails loudly instead of both parties silently sharing a token.
//
// Failure policy: fail CLOSED. Unlike lib/cache/valkey.ts (a best-effort
// perf tier that degrades to direct compute), this store gates a credential.
// If Valkey is unreachable we return null on both issue and redeem — the
// hand-off surfaces an error rather than falling back to a PAT-in-URL.
//
// Storage: a dedicated ioredis connection with enableOfflineQueue:false + a
// commandTimeout so a Valkey outage REJECTS fast (letting the fail-closed
// catch run) instead of queueing the command and hanging the request. Same
// rationale documented at length in lib/cache/valkey.ts.

import IORedis from "ioredis";
import { randomBytes } from "crypto";
import { getRedisUrl } from "@/lib/queue/connection";

/** Lifetime of an unredeemed exchange code. Kept tight — the app redeems
 * within the first round-trip after the deep link fires. */
export const EXCHANGE_CODE_TTL_SECONDS = 60;

// Distinct namespace from `cache:` (lib/cache/valkey.ts) and `bull:` (BullMQ).
const KEY_PREFIX = "mobile_exchange:";

// 32 bytes base64url → 43 chars. `validCodeShape` accepts the base64url
// alphabet within a length band so a malformed/oversized `code` param can
// never be interpolated into a key.
const CODE_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

const COMMAND_TIMEOUT_MS = 250;
let _redis: IORedis | null = null;

function safeRedis(): IORedis | null {
  if (_redis) return _redis;
  try {
    const conn = new IORedis(getRedisUrl(), {
      enableOfflineQueue: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      lazyConnect: false,
    });
    // Unhandled 'error' events are fatal in Node; every command is guarded by
    // a fail-closed try/catch, so swallow transient socket errors here.
    conn.on("error", () => {});
    _redis = conn;
    return _redis;
  } catch {
    return null;
  }
}

function keyFor(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

function validCodeShape(code: string): boolean {
  return CODE_SHAPE.test(code);
}

/**
 * Mint a fresh exchange code, store `code → pat` with a short TTL, and return
 * the code. Returns `null` if Valkey is unavailable (fail closed — the caller
 * MUST NOT fall back to putting the PAT in the redirect URL).
 *
 * `SET … EX NX`: NX guarantees we never clobber a live code on the
 * astronomically-unlikely 32-byte collision.
 */
export async function issueMobileExchangeCode(pat: string): Promise<string | null> {
  const redis = safeRedis();
  if (!redis || redis.status !== "ready") return null;
  const code = randomBytes(32).toString("base64url");
  try {
    const res = await redis.set(
      keyFor(code),
      pat,
      "EX",
      EXCHANGE_CODE_TTL_SECONDS,
      "NX",
    );
    return res === "OK" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Atomically redeem an exchange code: return the mapped PAT and delete the
 * entry in one round-trip (GETDEL) so a code can be spent at most once.
 * Returns `null` for a malformed, unknown, expired, or already-redeemed code,
 * and on any Valkey error (fail closed).
 */
export async function redeemMobileExchangeCode(code: string): Promise<string | null> {
  if (!validCodeShape(code)) return null;
  const redis = safeRedis();
  if (!redis || redis.status !== "ready") return null;
  try {
    const pat = await redis.getdel(keyFor(code));
    return pat && pat.length > 0 ? pat : null;
  } catch {
    return null;
  }
}
