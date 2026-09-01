// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { cache } from "react";
import type { WorkspaceRole } from "@/lib/authz";

export async function ensurePersonalWorkspace(userId: string) {
  const existing = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    // Backfill safety: if the user has a personal workspace but no membership
    // row (e.g. account predates 0012 backfill or row was deleted), insert
    // the owner row idempotently. Cheap on the hot path.
    await db
      .insert(schema.workspaceMemberships)
      .values({
        workspaceId: existing[0].id,
        userId,
        role: "owner",
        createdBy: null,
      })
      .onConflictDoNothing();
    return existing[0];
  }

  const [workspace] = await db
    .insert(schema.workspaces)
    .values({
      userId,
      name: "Personal",
      slug: "personal",
      kind: "personal",
      color: "#6366f1",
    })
    .returning();

  // Phase 3.1 — every new workspace gets an owner membership row. This is
  // the authoritative record going forward; workspaces.user_id lingers for
  // one release as a legacy pointer.
  await db
    .insert(schema.workspaceMemberships)
    .values({
      workspaceId: workspace.id,
      userId,
      role: "owner",
      createdBy: null,
    })
    .onConflictDoNothing();

  return workspace;
}

/**
 * Workspace row enriched with the caller's role on it. The pre-3.1 shape was
 * the bare workspaces table; 3.1 extends it with `role`. Existing call sites
 * destructure `{ id, name, slug, kind, color, createdAt }` and keep working;
 * new call sites can branch on `role` (e.g. hide member-management UI from
 * non-owners).
 */
export type UserWorkspace = typeof schema.workspaces.$inferSelect & {
  role: WorkspaceRole;
};

/**
 * Returns the workspaces the user has any role on, joined with their role.
 *
 * Pre-3.1 behaviour: `SELECT * FROM workspaces WHERE user_id = $1`.
 * Post-3.1 behaviour: join through `workspace_memberships`. For the
 * single-user case this returns the same set; for shared workspaces the
 * caller sees every workspace they've been invited to.
 */
// T1.1 / docs/claude/platform/completed/perf-audit/perf-audit-plan.md — React cache() memoises per-request keyed by
// userId so repeated lookups in one render (layout + server components) share
// the workspace fetch.
const _getUserWorkspaces = async (
  userId: string
): Promise<UserWorkspace[]> => {
  const rows = await db
    .select({
      workspace: schema.workspaces,
      role: schema.workspaceMemberships.role,
    })
    .from(schema.workspaceMemberships)
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id)
    )
    .where(eq(schema.workspaceMemberships.userId, userId));

  return rows.map((r) => ({
    ...r.workspace,
    role: r.role as WorkspaceRole,
  }));
};

export const getUserWorkspaces = cache(_getUserWorkspaces);

/**
 * List the members of a workspace. Used by `/api/v1/workspace/members`.
 *
 * Caller is responsible for authorising the request — typically with
 * `requireWorkspaceAccess(userId, workspaceId, 'viewer')`. We don't gate
 * inside the helper so it stays a pure data accessor.
 */
export async function getWorkspaceMembers(workspaceId: string) {
  return db
    .select({
      id: schema.workspaceMemberships.id,
      workspaceId: schema.workspaceMemberships.workspaceId,
      userId: schema.workspaceMemberships.userId,
      role: schema.workspaceMemberships.role,
      createdAt: schema.workspaceMemberships.createdAt,
      createdBy: schema.workspaceMemberships.createdBy,
    })
    .from(schema.workspaceMemberships)
    .where(eq(schema.workspaceMemberships.workspaceId, workspaceId));
}

// Re-export for callers that want the helper colocated.
export { assertWorkspaceAccess, requireWorkspaceAccess } from "@/lib/authz";
export type { WorkspaceRole };
// Used by sync routes that need to gate on "user has any role here".
export async function userHasAnyWorkspaceRole(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.workspaceMemberships.id })
    .from(schema.workspaceMemberships)
    .where(
      and(
        eq(schema.workspaceMemberships.userId, userId),
        eq(schema.workspaceMemberships.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
