// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Authorization helpers for multi-user workspaces (ADR 0004).
//
// Phase 3.1 lands the full membership-based model. Every mutating route MUST
// route through `assertWorkspaceAccess` (or its throwing variant
// `requireWorkspaceAccess`) before touching workspace-scoped state.
//
// Role ordering: owner > editor > viewer. The "minimum role" check uses this
// ordering — `requireWorkspaceAccess(.., 'editor')` is satisfied by both
// 'editor' and 'owner', not by 'viewer'.
//
// `requireWorkspaceOwner` from the 0.6 stub is preserved as a thin alias so
// existing call sites (e.g. the bull-board page) keep working unchanged.

import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import type { User } from "@/lib/auth/types";

// Phase 7b extended the ladder w/ two intermediate roles between viewer
// and editor:
//   viewer (1) < commenter (2) < contributor (3) < editor (4) < owner (5)
// Semantics:
//   - viewer:      read-only
//   - commenter:   read + post/delete-own comments (Phase 7a + 7b)
//   - contributor: read + comment + upload assets; NO delete/edit-others/share
//   - editor:      contributor + edit (rename/tag/move/trash), delete, share
//   - owner:       editor + member management + workspace settings + billing
// The CHECK constraint in migration 0028 enforces this vocab at the DB
// layer. Migration 0012's original CHECK was `IN ('owner','editor','viewer')`;
// 0028 drops + recreates it with the new vocab so existing rows stay valid.
export type WorkspaceRole =
  | "owner"
  | "editor"
  | "contributor"
  | "commenter"
  | "viewer";

export type AuthzFailure = "unauthenticated" | "forbidden";

export type AuthzResult =
  | { ok: true; user: User }
  | { ok: false; reason: AuthzFailure };

// Numeric rank for ordering comparisons. Higher = more authority.
const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  commenter: 2,
  contributor: 3,
  editor: 4,
  owner: 5,
};

/**
 * Returns the caller's role on a workspace, or null if they have no
 * membership row at all. Pure read — does not throw.
 */
export async function getUserWorkspaceRole(
  userId: string,
  workspaceId: string
): Promise<WorkspaceRole | null> {
  const rows = await db
    .select({ role: schema.workspaceMemberships.role })
    .from(schema.workspaceMemberships)
    .where(
      and(
        eq(schema.workspaceMemberships.userId, userId),
        eq(schema.workspaceMemberships.workspaceId, workspaceId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // The DB CHECK constraint enforces the role vocabulary; the cast is safe.
  return row.role as WorkspaceRole;
}

export type AccessReason = "no-membership" | "insufficient-role";

export type AccessResult =
  | { ok: true; role: WorkspaceRole }
  | { ok: false; reason: AccessReason };

/**
 * Assert that `userId` has at least `minimumRole` on `workspaceId`.
 *
 * Non-throwing — call sites pick how to surface the failure (404 vs 403,
 * redirect vs JSON envelope). For mutating route handlers, prefer the
 * throwing `requireWorkspaceAccess` helper below.
 *
 * Role ordering: owner > editor > viewer.
 */
export async function assertWorkspaceAccess(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole
): Promise<AccessResult> {
  const role = await getUserWorkspaceRole(userId, workspaceId);
  if (!role) return { ok: false, reason: "no-membership" };
  if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
    return { ok: false, reason: "insufficient-role" };
  }
  return { ok: true, role };
}

/**
 * Thrown by `requireWorkspaceAccess` on access denial. Route handlers should
 * `catch` this and translate to an HTTP envelope (the helper functions in
 * `lib/api/errors.ts` will do this for you once Phase 3.5 lands).
 *
 * The discriminant `name === 'WorkspaceAccessError'` is stable for
 * `error instanceof WorkspaceAccessError` checks across module boundaries.
 */
export class WorkspaceAccessError extends Error {
  readonly name = "WorkspaceAccessError" as const;
  readonly reason: AccessReason;
  readonly status: 403 | 404;
  constructor(reason: AccessReason) {
    super(
      reason === "no-membership"
        ? "No membership on this workspace"
        : "Insufficient role on this workspace"
    );
    this.reason = reason;
    // 404 hides workspace existence from non-members; 403 signals "you exist
    // here but can't do that".
    this.status = reason === "no-membership" ? 404 : 403;
  }
}

/**
 * Throwing variant of `assertWorkspaceAccess`. Use at the top of mutating
 * route handlers — one call, one failure mode, no branching ceremony.
 */
export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole
): Promise<WorkspaceRole> {
  const result = await assertWorkspaceAccess(userId, workspaceId, minimumRole);
  if (!result.ok) throw new WorkspaceAccessError(result.reason);
  return result.role;
}

/**
 * Convenience for route handlers: assert access OR return the canonical
 * NextResponse. Lets each mutation handler stay a one-liner check.
 *
 * Usage:
 *   const gate = await requireWorkspaceAccessOrResponse(user.id, wsId, 'editor');
 *   if (!gate.ok) return gate.response;
 *
 * On `no-membership` we return 404 (don't leak workspace existence to
 * non-members). On `insufficient-role` we return 403.
 */
export type GateResult =
  | { ok: true; role: WorkspaceRole }
  | { ok: false; response: NextResponse };

export async function requireWorkspaceAccessOrResponse(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole
): Promise<GateResult> {
  const result = await assertWorkspaceAccess(userId, workspaceId, minimumRole);
  if (result.ok) return { ok: true, role: result.role };
  const status = result.reason === "no-membership" ? 404 : 403;
  const message =
    result.reason === "no-membership"
      ? "Workspace not found"
      : "Forbidden: insufficient role";
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status }),
  };
}

/**
 * Resolve the current session and assert the user is the owner of
 * `workspaceId`. Returns the discriminated `AuthzResult` shape Phase 0.6
 * relied on so existing call sites (bull-board) keep working unchanged.
 *
 * Internally delegates to `assertWorkspaceAccess(.., 'owner')` — the
 * `workspaces.user_id` direct check has been retired.
 */
export async function requireWorkspaceOwner(
  workspaceId: string
): Promise<AuthzResult> {
  const user = await getAuthUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const result = await assertWorkspaceAccess(user.id, workspaceId, "owner");
  if (!result.ok) return { ok: false, reason: "forbidden" };
  return { ok: true, user };
}
