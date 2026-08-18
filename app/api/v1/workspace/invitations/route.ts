// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Workspace invitation collection endpoints.
//
//   GET  /api/v1/workspace/invitations — list pending invitations
//   POST /api/v1/workspace/invitations — mint a new invitation
//
// Both require session auth on the caller's primary workspace. PAT auth is
// permitted but the same authz check applies — the caller must own (or, once
// Phase 3.1 lands, have an `editor`+ membership in) the target workspace.
//
// On POST we generate a plaintext token, persist it, fire the (stubbed)
// email send, and return `{ id, token, url }` so the inviter can paste the
// URL anywhere until Phase 7.3 brings real email infrastructure online.
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { requireWorkspaceOwner } from "@/lib/authz";
import { getUserWorkspaces } from "@/lib/workspace";
import {
  createInvitation,
  listPendingInvitations,
  normalizeEmail,
} from "@/lib/invitations/core";
import { sendInvitationEmail } from "@/lib/invitations/email";

const CreateBody = z.object({
  email: z.string().email().max(254),
  role: z.enum(["editor", "viewer"]),
});

function inviteUrl(token: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3500";
  return `${base.replace(/\/$/, "")}/invitations/${token}`;
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  const workspace = workspaces[0];

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) {
    return NextResponse.json(
      { error: authz.reason === "unauthenticated" ? "Unauthorized" : "Forbidden" },
      { status: authz.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  const rows = await listPendingInvitations(workspace.id);
  return NextResponse.json({
    invitations: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      role: row.role as "editor" | "viewer",
      token: row.token,
      url: inviteUrl(row.token),
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  const workspace = workspaces[0];

  // Phase 3.3: use the Phase 0.6 owner stub until 3.1's
  // `assertWorkspaceAccess(_, _, 'editor')` helper lands. Inviting is an
  // owner-only operation today.
  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) {
    return NextResponse.json(
      { error: authz.reason === "unauthenticated" ? "Unauthorized" : "Forbidden" },
      { status: authz.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid body", detail: String(err) },
      { status: 400 }
    );
  }

  const email = normalizeEmail(body.email);

  // Defensive: don't invite the workspace owner themselves. The owner
  // already has full access; the membership unique key would clash anyway.
  if (user.email && normalizeEmail(user.email) === email) {
    return NextResponse.json(
      { error: "You cannot invite yourself" },
      { status: 400 }
    );
  }

  const row = await createInvitation({
    workspaceId: workspace.id,
    email,
    role: body.role,
    invitedBy: user.id,
  });

  const url = inviteUrl(row.token);
  // Stubbed in Phase 3.3 — see lib/invitations/email.ts. We don't block on
  // it (the token + URL are in the response either way), and we don't fail
  // the request if the stub errors.
  try {
    await sendInvitationEmail({
      to: row.email,
      workspaceName: workspace.name,
      inviterEmail: user.email ?? "",
      inviterName: user.name ?? null,
      role: row.role as "editor" | "viewer",
      acceptUrl: url,
      expiresAt: row.expiresAt,
    });
  } catch {
    // Swallow — the inviter can share the URL manually.
  }

  return NextResponse.json({
    id: row.id,
    token: row.token,
    url,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role as "editor" | "viewer",
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

