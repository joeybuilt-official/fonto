// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.2 — append-only audit log helper.
//
// Call `recordAuditEvent(...)` from any mutating route/server action. The
// helper extracts a truncated IP subnet (/24 IPv4, /48 IPv6) and a length-
// capped User-Agent from the optional `request` arg, then writes one row to
// `fonto.audit_log`.
//
// CRITICAL: audit logging must NEVER break the request path. Every insert
// is fire-and-forget — the function returns a resolved promise even if the
// DB write fails. Failures are logged via pino at warn level (component=
// audit.write) and dropped. Callers are encouraged to use `void` or rely on
// the swallowed error so an unawaited promise rejection cannot bubble up.
//
// Privacy: raw IPs are NEVER persisted. This is intentional — see ADR 0007
// (data retention + privacy) and the matching stance in Phase 2.5
// share_link_views, which hashes-with-salt rather than truncating because
// those rows are surfaced publicly. The admin audit log is workspace-owner-
// only, so a coarse subnet is enough to spot rogue access without enabling
// per-user IP tracking.

import type { NextRequest } from "next/server";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";

const auditLogger = logger.child({ component: "audit.write" });

/**
 * Canonical action vocabulary. Keep this in lockstep with the admin viewer
 * filter dropdown and the audit retention policy in ADR 0007.
 */
export const AuditAction = {
  // workspace lifecycle (3.3 invitations)
  WorkspaceCreate: "workspace.create",
  WorkspaceInvite: "workspace.invite",
  WorkspaceMemberRoleChange: "workspace.member.role-change",
  WorkspaceMemberRemove: "workspace.member.remove",
  // assets
  AssetUpload: "asset.upload",
  AssetUpdate: "asset.update",
  AssetDelete: "asset.delete",
  AssetRestore: "asset.restore",
  AssetArchive: "asset.archive",
  // shares
  ShareCreate: "share.create",
  ShareRevoke: "share.revoke",
  // tokens (Phase 2.1)
  TokenMint: "token.mint",
  TokenRevoke: "token.revoke",
  // webhooks (Phase 2.4)
  WebhookCreate: "webhook.create",
  WebhookUpdate: "webhook.update",
  WebhookDelete: "webhook.delete",
  // settings
  SettingsUpdate: "settings.update",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface RecordAuditEventArgs {
  /** Workspace this event belongs to. Nullable for user-scoped events
   *  (token.mint, token.revoke, etc.). Required for everything else. */
  workspaceId?: string | null;
  /** The acting user. Always required — we want to know who did this. */
  userId: string;
  /** Action key from the AuditAction const. */
  action: AuditAction;
  /** Target entity kind: 'asset' | 'share_link' | 'webhook_endpoint' | etc. */
  targetType?: string | null;
  /** Target id — uuid OR slug OR hex; stored as text. */
  targetId?: string | null;
  /** Free-form structured context. Keep small; this is jsonb but the column
   *  is intentionally not indexed for general querying. */
  metadata?: Record<string, unknown>;
  /** Pass `request` from the route handler so we can extract IP + UA. The
   *  helper truncates the IP to /24 (IPv4) or /48 (IPv6) before storing. */
  request?: NextRequest | Request | null;
}

/**
 * Append one row to `fonto.audit_log`. Returns a resolved promise on success
 * AND on failure — audit logging is a strict best-effort side channel and
 * must never block, fail, or reject the calling request.
 */
export async function recordAuditEvent(args: RecordAuditEventArgs): Promise<void> {
  try {
    const { ipAddress, userAgent } = args.request
      ? extractRequestSignals(args.request)
      : { ipAddress: null, userAgent: null };

    await db
      .insert(schema.auditLog)
      .values({
        workspaceId: args.workspaceId ?? null,
        userId: args.userId,
        action: args.action,
        targetType: args.targetType ?? null,
        targetId: args.targetId ?? null,
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
        ipAddress,
        userAgent,
      })
      .catch((err: unknown) => {
        auditLogger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            action: args.action,
            workspaceId: args.workspaceId ?? null,
            userId: args.userId,
          },
          "audit log insert failed (dropped)"
        );
      });
  } catch (err) {
    // Belt-and-braces: extractRequestSignals or anything else that throws
    // synchronously must not reach the caller.
    auditLogger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        action: args.action,
      },
      "audit log emit threw (dropped)"
    );
  }
}

// ---------------------------------------------------------------------------
// IP truncation helpers
// ---------------------------------------------------------------------------

/**
 * Truncate an IPv4 address to its /24 network prefix.
 *
 * Example: 203.0.113.42 → 203.0.113.0/24
 *
 * Returns null if the input is not a syntactically valid dotted-quad.
 */
export function ipv4ToSlash24(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
}

/**
 * Truncate an IPv6 address to its /48 network prefix.
 *
 * Example: 2001:db8:1234:5678::1 → 2001:db8:1234::/48
 *
 * Handles `::` shorthand and IPv4-mapped (`::ffff:1.2.3.4`) by delegating
 * the latter to ipv4ToSlash24 after stripping the mapping prefix. Returns
 * null if the input doesn't look like IPv6.
 */
export function ipv6ToSlash48(ip: string): string | null {
  if (ip.startsWith("::ffff:") || ip.startsWith("::FFFF:")) {
    const v4 = ip.slice(7);
    const truncated = ipv4ToSlash24(v4);
    return truncated; // Treat IPv4-mapped as IPv4.
  }
  if (!ip.includes(":")) return null;

  // Expand the `::` shorthand to a full 8-group form.
  let groups: string[];
  if (ip.includes("::")) {
    const [head, tail] = ip.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - (headGroups.length + tailGroups.length);
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;
  // Validate each group is 1..4 hex chars.
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;

  // First 3 groups = /48.
  const prefix = groups.slice(0, 3).map((g) => g.toLowerCase()).join(":");
  return `${prefix}::/48`;
}

/**
 * Pick the client IP out of the standard reverse-proxy headers, then
 * truncate it to a subnet. Order of preference mirrors how middleware in
 * this app already trusts headers (see lib/auth/server.ts and the share-link
 * IP-hashing logic).
 */
function truncateClientIp(rawIp: string | null): string | null {
  if (!rawIp) return null;
  const trimmed = rawIp.trim();
  if (!trimmed) return null;

  // Strip surrounding brackets common in `[::1]:1234` Forwarded headers.
  const cleaned = trimmed.replace(/^\[|\]$/g, "");

  // IPv4 first.
  const v4 = ipv4ToSlash24(cleaned);
  if (v4) return v4;
  return ipv6ToSlash48(cleaned);
}

function extractRequestSignals(req: NextRequest | Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  let rawIp: string | null = null;
  // `x-forwarded-for` may contain a comma-separated chain. The leftmost
  // entry is the original client; we only need the first.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) rawIp = xff.split(",")[0]?.trim() ?? null;
  if (!rawIp) rawIp = req.headers.get("x-real-ip");
  if (!rawIp) rawIp = req.headers.get("cf-connecting-ip");

  const ua = req.headers.get("user-agent");
  return {
    ipAddress: truncateClientIp(rawIp),
    userAgent: ua ? ua.slice(0, 500) : null,
  };
}
