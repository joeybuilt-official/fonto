// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.1 — list members of the caller's primary workspace.
//
// The Phase 3.3 invitation flow will land POST/DELETE here. For now this is
// read-only: any member (viewer or higher) can see who else has access.

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces, getWorkspaceMembers } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  const workspaceId = workspaces[0].id;

  // Gate at viewer or higher. Non-members get 404 (don't leak membership
  // existence). The viewer floor matches the "any role can see the roster"
  // decision in ADR 0004.
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "viewer");
  if (!gate.ok) return gate.response;

  const members = await getWorkspaceMembers(workspaceId);

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      workspaceId: m.workspaceId,
      userId: m.userId,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
      createdBy: m.createdBy,
    })),
  });
}
