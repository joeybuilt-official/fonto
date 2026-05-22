// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Authorization helpers for admin-only surfaces.
//
// STUB FOR PHASE 0.6 — the full multi-user RBAC model arrives in Phase 3
// (`workspace_memberships` with owner/editor/viewer + `assertWorkspaceAccess`
// audit-logged helper — see Phase 3 of the Fonto → Immich parity plan and
// ADR 0005). Until then, "admin" === workspace owner. Every workspace in
// the system today is single-owner; `workspaces.userId` is the canonical
// owner column.
//
// Call this from Server Components and admin route handlers that mutate or
// expose operational state. The shape of the return value is intentionally
// discriminated so the caller decides how to render the failure (a 401 for
// API routes, a redirect-to-login for pages, an "Admins only" panel for the
// jobs page, etc.).

import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import type { User } from "@/lib/auth/types";

export type AuthzFailure = "unauthenticated" | "forbidden";

export type AuthzResult =
  | { ok: true; user: User }
  | { ok: false; reason: AuthzFailure };

/**
 * Resolve the current session and assert the user owns the given workspace.
 *
 * @param workspaceId UUID of the workspace the caller wants to act on.
 *   Pass the active workspace from the page/route resolver (typically the
 *   user's personal workspace).
 *
 * @returns
 *   - `{ ok: true, user }` — session valid AND `workspaces.userId === user.id`
 *   - `{ ok: false, reason: 'unauthenticated' }` — no session
 *   - `{ ok: false, reason: 'forbidden' }` — session OK but not the owner
 *     (or the workspace does not exist)
 *
 * NOTE (Phase 3): this helper will be superseded by `assertWorkspaceAccess`
 * which checks `workspace_memberships` for role-based access and writes to
 * `audit_log`. Call sites of `requireWorkspaceOwner` should be the first
 * thing to migrate when that lands. Keep the function signature
 * `(workspaceId) => AuthzResult` so the swap is a rename.
 */
export async function requireWorkspaceOwner(
  workspaceId: string
): Promise<AuthzResult> {
  const user = await getAuthUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const rows = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace || workspace.userId !== user.id) {
    return { ok: false, reason: "forbidden" };
  }

  return { ok: true, user };
}
