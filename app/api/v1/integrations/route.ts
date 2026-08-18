// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 (media import) — GET /api/v1/integrations
//
// Returns the caller's third-party integrations (provider + status only) so
// the Settings → Integrations UI can render the right Connect / Connected /
// Reconnect state. Session-authed + workspace-scoped. NEVER returns the
// encrypted refresh token or any secret material.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ integrations: [] });
  }
  const workspace = workspaces[0];

  const rows = await db
    .select({
      provider: schema.integrations.provider,
      status: schema.integrations.status,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, workspace.id),
        eq(schema.integrations.userId, user.id)
      )
    );

  return NextResponse.json({ integrations: rows });
}
