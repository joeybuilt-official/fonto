// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Server-side auth resolution.
//
// Two paths converge here:
//   1. Session cookie (web client) — Better Auth's getSession.
//   2. Personal Access Token (mobile / CLI / 3rd-party) — see
//      `lib/auth/api-keys.ts`. Header conventions: `Authorization: Bearer
//      fonto_pat_...` or `x-api-key: fonto_pat_...`.
//
// `getAuthUser()` keeps its original signature (User | null) so existing
// call sites work unchanged. For routes that need to know HOW the caller
// authenticated (e.g. "no PAT may create more PATs"), use `getAuthContext()`
// — it returns the same user plus an `authMethod` discriminator and, for
// PAT callers, the verified-key blob so scope enforcement can read scopes
// off it without a re-lookup.
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { cache } from "react";
import type { User } from "./types";
import {
  verifyPatFromHeaders,
  rateLimitExceeded,
  type VerifiedApiKey,
} from "./api-keys";

export type AuthMethod = "session" | "apiKey";

export interface AuthContext {
  user: User;
  authMethod: AuthMethod;
  /** Populated only when `authMethod === 'apiKey'`. */
  apiKey: VerifiedApiKey | null;
}

/**
 * Resolve the calling user from either a session cookie or a PAT header.
 * Session cookies take precedence — when both are present (e.g. the user is
 * logged in AND sending a PAT for testing), the session wins so we never
 * accidentally apply scope gating to a browser session.
 *
 * Returns `null` when neither auth method succeeds, or when a PAT was
 * presented but the per-key rate limit is exceeded.
 */
// T1.1 / docs/claude/platform/completed/perf-audit/perf-audit-plan.md — React cache() memoises per-request so middleware,
// server components, and route handlers in the same render share one auth lookup.
async function _getAuthContext(): Promise<AuthContext | null> {
  try {
    const requestHeaders = await headers();

    // 1. Session-cookie path.
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (session?.user) {
      return {
        user: session.user as User,
        authMethod: "session",
        apiKey: null,
      };
    }

    // 2. PAT path. Only attempt if there's a relevant header — saves a DB
    // round-trip on unauth'd public requests.
    const hasPatHeader =
      requestHeaders.get("x-api-key") ||
      requestHeaders.get("authorization");
    if (!hasPatHeader) return null;

    const verified = await verifyPatFromHeaders(requestHeaders);
    if (!verified) return null;

    // Enforce per-key rate limit. We treat this as auth failure — callers
    // see a 401, not a 429, since they don't know we rate-limit. (If a 429
    // is preferred, route handlers can read `authMethod`/keyId and inspect
    // the bucket themselves; for now, fail-closed is the safer default.)
    if (rateLimitExceeded(verified.keyId)) return null;

    return {
      user: verified.user,
      authMethod: "apiKey",
      apiKey: verified,
    };
  } catch {
    return null;
  }
}

export const getAuthContext = cache(_getAuthContext);

/**
 * Back-compat wrapper. Identical to `getAuthContext().then(c => c?.user ?? null)`
 * but exported under its historical name so existing call sites keep working
 * without touching every route.
 */
// T1.1 / docs/claude/platform/completed/perf-audit/perf-audit-plan.md — wrapped in cache() so repeated getAuthUser()
// calls within one request share the underlying getAuthContext memo.
const _getAuthUser = async (): Promise<User | null> => {
  const ctx = await getAuthContext();
  return ctx?.user ?? null;
};

export const getAuthUser = cache(_getAuthUser);
