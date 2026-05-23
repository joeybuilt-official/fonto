// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// POST /api/v1/workspace/invitations/:token/accept
//
// Claim an invitation. Requires a session — if the user isn't signed in,
// they're bounced to Better Auth's signup flow via a 401 with a hint that
// the client should redirect. The acceptance page (`app/invitations/[token]`)
// handles that redirect: it links to the login page with `?callback=` set
// to itself, so after signup the same Accept button reposts here.
//
// Acceptance:
//   1. validate token (exists, not revoked, not accepted, not expired)
//   2. enforce that the signed-in user's email matches the invited email
//      (case-insensitive). This is the "did the right person claim it"
//      check; without it any signed-in user who got the link could join.
//   3. insert a `workspace_memberships` row with the invitation's role
//   4. flip `accepted_at`/`accepted_by_user_id` on the invitation row
//
// Memberships table: see Phase 3.1 / ADR 0004 (`fonto.workspace_memberships`).
// We write via a raw parameterized SQL insert because the Drizzle schema
// entry for that table lands in 3.1, not 3.3 — keeping the write here
// rather than in the schema avoids two PRs racing on the same `export const`.
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { db } from "@/lib/db";
import {
  classifyInvitation,
  findInvitationByToken,
  markInvitationAccepted,
  normalizeEmail,
} from "@/lib/invitations/core";

export async function POST(
  _req: Request,
  context: { params: Promise<{ token: string }> }
) {
  const user = await getAuthUser();
  if (!user) {
    // Hint to the client to send the user through signup. Keeping the body
    // structured lets the acceptance page key off the `signupRequired` flag
    // rather than the status code.
    return NextResponse.json(
      {
        error: "Sign in required",
        signupRequired: true,
      },
      { status: 401 }
    );
  }

  const { token } = await context.params;
  const inv = await findInvitationByToken(token);
  if (!inv) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  const state = classifyInvitation(inv);
  if (state !== "pending") {
    return NextResponse.json(
      {
        error:
          state === "expired"
            ? "This invitation has expired"
            : state === "revoked"
              ? "This invitation has been revoked"
              : "This invitation has already been accepted",
        state,
      },
      { status: 410 }
    );
  }

  // Email-match check. Better Auth's `user.email` is canonical. Compare
  // case-insensitively (stored already lowercase on insert).
  if (!user.email || normalizeEmail(user.email) !== inv.email) {
    return NextResponse.json(
      {
        error:
          "This invitation was sent to a different email address. Sign in with that address.",
        expectedEmail: inv.email,
      },
      { status: 403 }
    );
  }

  // Insert the membership. Idempotent via ON CONFLICT — if Phase 3.1's
  // unique key on (workspace_id, user_id) is already populated for this
  // pair (e.g. the user is already a member, or this is a retry), we
  // silently keep the existing row and still mark the invitation accepted.
  try {
    await db.execute(
      sql`
        INSERT INTO fonto.workspace_memberships
          (workspace_id, user_id, role, invited_by)
        VALUES
          (${inv.workspaceId}, ${user.id}, ${inv.role}, ${inv.invitedBy})
        ON CONFLICT (workspace_id, user_id) DO NOTHING
      `
    );
  } catch (err) {
    // The most likely cause in early Phase 3 is that 3.1's migration hasn't
    // been applied yet. Surface the error clearly so the operator knows
    // which migration to run.
    return NextResponse.json(
      {
        error: "Unable to create membership",
        detail:
          "fonto.workspace_memberships may not exist yet — apply Phase 3.1's migration (0012) and retry.",
        cause: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  const accepted = await markInvitationAccepted(inv.id, user.id);
  if (!accepted) {
    // Race: another request flipped it between our state-check and now.
    return NextResponse.json(
      { error: "Invitation could not be accepted (concurrent state change)" },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    workspaceId: accepted.workspaceId,
    role: accepted.role as "editor" | "viewer",
    acceptedAt: accepted.acceptedAt?.toISOString() ?? null,
  });
}
