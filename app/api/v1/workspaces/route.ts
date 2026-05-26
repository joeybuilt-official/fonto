// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — list the caller's workspaces.
//
//   GET /api/v1/workspaces
//     Returns every workspace the caller is a member of (any role).
//     Used by the share-to-workspace UI to populate the target picker
//     and by future workspace-switcher widgets.
//
// Distinct from /api/v1/workspace (singular) which returns one workspace
// + its storage stats; this is a thin list endpoint.

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);

  return NextResponse.json({
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      kind: w.kind,
      color: w.color,
      role: w.role,
      createdAt: w.createdAt.toISOString(),
    })),
  });
}
