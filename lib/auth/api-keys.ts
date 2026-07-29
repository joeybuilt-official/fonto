// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Personal Access Token (PAT) auth.
//
// Wire format: `fonto_pat_<id>_<secret>` where:
//   - `fonto_pat_` is the public prefix (`API_KEY_DEFAULT_PREFIX`).
//   - `<id>` is the row UUID (no dashes), used to look up the hash row.
//   - `<secret>` is 32 bytes of random data, base64url-encoded. We store
//     only its SHA-256 digest and timing-safe-compare on verify.
//
// This module is the only place that constructs, parses, or verifies PATs.
// `lib/auth/server.ts::getAuthUser()` calls `verifyPatFromHeaders` to resolve
// the caller from `Authorization: Bearer` or `x-api-key`.
//
// We do NOT use Better Auth's `apiKey` plugin because it is not shipped in
// the installed version (1.6.9). The shape of `fonto.api_keys` mirrors what
// the plugin would give us so a future swap is a mechanical rename.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { auth } from "@/lib/auth";
import type { User } from "./types";

export const API_KEY_DEFAULT_PREFIX = "fonto_pat_";

// Headers we accept a PAT on. The `authorization` header must use the
// `Bearer ` scheme; any other scheme is ignored.
export const API_KEY_HEADERS = ["x-api-key", "authorization"] as const;

// Rate-limit config (per-key sliding window). Wired by the rate-limit
// helper below. 600 requests per 60s ≈ 10rps default. Override per-route
// if needed; this is a floor, not a ceiling.
export const API_KEY_RATE_LIMIT = {
  enabled: true,
  timeWindowMs: 60_000,
  maxRequests: 600,
} as const;

export type ApiKeyScope = "read" | "write" | "admin";

const ALL_SCOPES: ApiKeyScope[] = ["read", "write", "admin"];

/**
 * Normalize / validate a scope value from JSONB. Anything that isn't a known
 * scope name is dropped — the column is JSONB and could in principle hold
 * anything. Default fall-through is `read` per the parity plan.
 */
export function parseScopes(raw: unknown): ApiKeyScope[] {
  if (!Array.isArray(raw)) return ["read"];
  const out = raw.filter((s): s is ApiKeyScope =>
    typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s)
  );
  return out.length > 0 ? out : ["read"];
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; if the lengths differ we
  // know the hashes don't match, but still run a comparison to avoid early
  // exit timing leaks.
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) {
    // Compare against a zero buffer of equal length so the operation still
    // takes a deterministic amount of time.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Mint a new PAT for the given user.
 *
 * Returns the freshly-inserted row metadata AND the plaintext token. The
 * plaintext is the ONLY chance the caller has to see it — we never persist
 * it, only its hash. Surface it to the user immediately, then forget it.
 */
export async function createApiKey(params: {
  userId: string;
  name: string;
  scopes: ApiKeyScope[];
  expiresInDays?: number | null; // null/undefined => never expires
  metadata?: Record<string, unknown>;
}): Promise<{
  id: string;
  token: string;
  name: string;
  prefix: string;
  firstFour: string;
  lastFour: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  createdAt: Date;
}> {
  const scopes = params.scopes.length > 0 ? params.scopes : ["read"];
  // 32 bytes of randomness, base64url-encoded → 43 chars, no padding.
  const secret = randomBytes(32).toString("base64url");
  const secretHash = sha256Hex(secret);
  const firstFour = secret.slice(0, 4);
  const lastFour = secret.slice(-4);

  const expiresAt =
    params.expiresInDays && params.expiresInDays > 0
      ? new Date(Date.now() + params.expiresInDays * 86_400_000)
      : null;

  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      userId: params.userId,
      name: params.name,
      prefix: API_KEY_DEFAULT_PREFIX,
      firstFour,
      lastFour,
      secretHash,
      scopes,
      metadata: params.metadata ?? null,
      expiresAt,
    })
    .returning();

  // Wire-format the token. The id portion is the dash-less uuid so it can
  // be parsed with a single split.
  const idCompact = row.id.replace(/-/g, "");
  const token = `${API_KEY_DEFAULT_PREFIX}${idCompact}_${secret}`;

  return {
    id: row.id,
    token,
    name: row.name,
    prefix: row.prefix,
    firstFour: row.firstFour,
    lastFour: row.lastFour,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** A PAT key row plus the resolved owner-user. Returned by `verifyApiKey`. */
export interface VerifiedApiKey {
  user: User;
  keyId: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
}

/**
 * Verify a wire-format PAT. Returns the resolved user + key metadata on
 * success, or `null` if the token is malformed, unknown, revoked, or expired.
 */
export async function verifyApiKey(token: string): Promise<VerifiedApiKey | null> {
  if (!token.startsWith(API_KEY_DEFAULT_PREFIX)) return null;
  const body = token.slice(API_KEY_DEFAULT_PREFIX.length);
  const sepIdx = body.indexOf("_");
  if (sepIdx < 0) return null;
  const idCompact = body.slice(0, sepIdx);
  const secret = body.slice(sepIdx + 1);
  if (idCompact.length !== 32 || secret.length < 8) return null;

  // Reconstruct the uuid (8-4-4-4-12).
  const keyId = `${idCompact.slice(0, 8)}-${idCompact.slice(8, 12)}-${idCompact.slice(
    12,
    16
  )}-${idCompact.slice(16, 20)}-${idCompact.slice(20, 32)}`;

  const rows = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, keyId), isNull(schema.apiKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Expired?
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Hash match?
  const candidateHash = sha256Hex(secret);
  if (!constantTimeEqualHex(candidateHash, row.secretHash)) return null;

  // Resolve the owner user via Better Auth's admin API.
  // (We don't have a direct lookup helper exposed, so we hit getSession with
  // the user id pseudo-session is not possible; instead, query the auth.user
  // table via the same pool. Keep this dependency-light: the auth schema is
  // small and stable.)
  const user = await loadUserById(row.userId);
  if (!user) return null;

  // Best-effort `last_used_at` stamp. Don't block on it.
  void db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch(() => {
      /* swallow — non-fatal */
    });

  return {
    user,
    keyId: row.id,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expiresAt,
  };
}

/**
 * Resolve a PAT from incoming request headers. Accepts both
 * `Authorization: Bearer <token>` and `x-api-key: <token>`. The `x-api-key`
 * header takes precedence if both are present.
 */
export async function verifyPatFromHeaders(
  headers: Headers
): Promise<VerifiedApiKey | null> {
  const xApiKey = headers.get("x-api-key");
  if (xApiKey && xApiKey.startsWith(API_KEY_DEFAULT_PREFIX)) {
    const r = await verifyApiKey(xApiKey);
    if (r) return r;
  }
  const authz = headers.get("authorization");
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (m && m[1].startsWith(API_KEY_DEFAULT_PREFIX)) {
      const r = await verifyApiKey(m[1]);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Load a Better Auth user by id from the shared auth schema. We query via
 * the same pg pool Better Auth uses, but at the SQL level — Better Auth
 * doesn't currently export a public `getUserById` for server-side callers.
 */
async function loadUserById(userId: string): Promise<User | null> {
  // `auth` is the Better Auth instance, which holds the configured database
  // adapter. Reach into it to get the raw user row. The adapter's `findOne`
  // takes a model name + where clause and returns the row or null.
  // betterAuth's `$context` exposes the adapter.
  try {
    const ctx = await auth.$context;
    const row = await ctx.adapter.findOne<Record<string, unknown>>({
      model: "user",
      where: [{ field: "id", value: userId }],
    });
    if (!row) return null;
    return row as unknown as User;
  } catch {
    return null;
  }
}

// ── Scope enforcement ────────────────────────────────────────────────────────

export class ScopeError extends Error {
  readonly required: ApiKeyScope;
  readonly granted: ApiKeyScope[];
  constructor(required: ApiKeyScope, granted: ApiKeyScope[]) {
    super(
      `API key scope '${required}' required (granted: ${granted.join(", ") || "none"})`
    );
    this.name = "ScopeError";
    this.required = required;
    this.granted = granted;
  }
}

/**
 * Assert that a verified PAT grants the given scope. Throws `ScopeError` if
 * not. `admin` implies `write` implies `read`.
 *
 * Pass `null` for tokens that came from a session (not a PAT) — session auth
 * implies full scope.
 */
export function requireScope(
  token: VerifiedApiKey | null,
  scope: ApiKeyScope
): void {
  if (!token) return; // session auth: no scope gate
  if (hasScope(token.scopes, scope)) return;
  throw new ScopeError(scope, token.scopes);
}

export function hasScope(granted: ApiKeyScope[], required: ApiKeyScope): boolean {
  if (granted.includes("admin")) return true;
  if (required === "admin") return false;
  if (granted.includes("write")) return true; // implies read
  return granted.includes(required);
}

// ── Per-key rate limit ──────────────────────────────────────────────────────
//
// In-process sliding window. This is intentionally light: it protects the API
// from a runaway client, not from a distributed brute-force. Distributed rate
// limiting belongs at the edge (Caddy/Cloudflare). The window resets on
// process restart, which is fine for the threat model.

const rateBuckets = new Map<string, number[]>();

/**
 * Returns `true` if the key has exceeded its rate limit. Side effect:
 * records the current request in the bucket.
 */
export function rateLimitExceeded(keyId: string): boolean {
  if (!API_KEY_RATE_LIMIT.enabled) return false;
  const now = Date.now();
  const cutoff = now - API_KEY_RATE_LIMIT.timeWindowMs;
  const bucket = rateBuckets.get(keyId) ?? [];
  // Prune expired entries.
  const pruned = bucket.filter((t) => t > cutoff);
  pruned.push(now);
  rateBuckets.set(keyId, pruned);
  return pruned.length > API_KEY_RATE_LIMIT.maxRequests;
}

// ── Owner-scoped reads + revoke for the /settings UI ────────────────────────

export interface ApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  firstFour: string;
  lastFour: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export async function listApiKeysForUser(userId: string): Promise<ApiKeyListItem[]> {
  const rows = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.userId, userId), isNull(schema.apiKeys.revokedAt)));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    firstFour: r.firstFour,
    lastFour: r.lastFour,
    scopes: parseScopes(r.scopes),
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Soft-delete (revoke) an API key. Owner-scoped: callers must pass the
 * authenticated user's id; we refuse cross-user revocations.
 */
export async function revokeApiKey(
  userId: string,
  keyId: string
): Promise<boolean> {
  const result = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.userId, userId)))
    .returning({ id: schema.apiKeys.id });
  return result.length > 0;
}
