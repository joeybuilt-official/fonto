// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Single-invitation endpoints, keyed by the public token.
//
//   GET    /api/v1/workspace/invitations/:token  — PUBLIC; metadata for the
//                                                  acceptance page render.
//   DELETE /api/v1/workspace/invitations/:token  — owner-only; revoke. For
//                                                  ergonomics the segment
//                                                  also accepts the row id.
//
// Why one segment name (`[token]`) and not separate `[id]` / `[token]`
// directories: Next.js App Router requires sibling dynamic segments at the
// same path depth to share the same param name. Both invitation tokens
// (base64url, ~43 chars) and ids (UUIDs) are unique and trivially
// distinguishable at runtime, so the DELETE handler accepts either.
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { db, schema } from "@/lib/db";
import {
  classifyInvitation,
  findInvitationByToken,
  revokeInvitation,
} from "@/lib/invitations/core";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public — used by `app/invitations/[token]/page.tsx` to render the accept
 * card before the user is signed in. Returns only the fields needed for
 * that render; never includes the inviter's id or the workspace id (both
 * irrelevant to the recipient and unnecessary attack surface).
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const inv = await findInvitationByToken(token);
  if (!inv) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  const state = classifyInvitation(inv);

  // Look up the workspace name (always; the accept page needs it even for
  // an expired invite to render the "X invited you to Y" sentence).
  const [workspace] = await db
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, inv.workspaceId))
    .limit(1);

  // Look up the inviter's email by joining Better Auth's user table.
  // Better Auth lives in a different schema (`auth`), so we use a raw
  // parameterized query rather than adding it to our Drizzle schema.
  let inviterEmail: string | null = null;
  let inviterName: string | null = null;
  try {
    const rows = (await db.execute(
      sql`SELECT email, name FROM auth."user" WHERE id = ${inv.invitedBy} LIMIT 1`
    )) as unknown as Array<{ email: string | null; name: string | null }>;
    if (rows && rows[0]) {
      inviterEmail = rows[0].email ?? null;
      inviterName = rows[0].name ?? null;
    }
  } catch {
    // Cross-schema lookup is best-effort. If it fails we still render.
  }

  return NextResponse.json({
    workspace: { name: workspace?.name ?? "a workspace" },
    inviterEmail,
    inviterName,
    role: inv.role as "editor" | "viewer",
    email: inv.email,
    state,
    expired: state === "expired",
    used: state === "accepted",
    revoked: state === "revoked",
    expiresAt: inv.expiresAt.toISOString(),
  });
}

/**
 * Revoke an invitation. Owner-only; the param may be either the token
 * (canonical) or the row id (for the settings UI which has the id handy).
 */
export async function DELETE(
  _req: Request,
  context: { params: Promise<{ token: string }> }
) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token } = await context.params;

  // Look up by id or by token.
  const inv = await (UUID_RE.test(token)
    ? db
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.id, token))
        .limit(1)
        .then((r) => r[0] ?? null)
    : findInvitationByToken(token));

  if (!inv) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  // Inviter must own the target workspace. We resolve owner from
  // `workspaces.userId` (Phase 0.6 stub model — one owner per workspace).
  const [ws] = await db
    .select({ userId: schema.workspaces.userId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, inv.workspaceId))
    .limit(1);
  if (!ws || ws.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const revoked = await revokeInvitation(inv.id, inv.workspaceId);
  if (!revoked) {
    return NextResponse.json(
      { error: "Invitation already accepted or revoked" },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, id: revoked.id });
}

