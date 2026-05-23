// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — GET /api/v1/stacks/suggestions
//
// Runs `suggestStacks(workspaceId)` and returns the first 50 hits. The
// suggester is READ-ONLY — it never creates `fonto.stacks` rows. The user
// confirms each suggestion via `POST /api/v1/stacks/suggestions/accept`.

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { suggestStacks } from "@/lib/stacks/suggest";

const MAX_SUGGESTIONS = 50;

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ suggestions: [] });
  }
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    workspaceId,
    "viewer"
  );
  if (!gate.ok) return gate.response;

  const suggestions = await suggestStacks(workspaceId);
  return NextResponse.json({
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    total: suggestions.length,
  });
}
