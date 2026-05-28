// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, ne, count } from "drizzle-orm";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspace = workspaces[0];

  // Phase 9.1 — read usage_bytes + quota_bytes from the maintained column.
  const [ws] = await db
    .select({ usageBytes: schema.workspaces.usageBytes, quotaBytes: schema.workspaces.quotaBytes })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspace.id))
    .limit(1);

  const [countRow] = await db
    .select({ n: count() })
    .from(schema.assets)
    .where(and(eq(schema.assets.workspaceId, workspace.id), ne(schema.assets.lifecycleState, "purged")));

  return NextResponse.json({
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    storage: {
      usageBytes: ws?.usageBytes ?? 0,
      quotaBytes: ws?.quotaBytes ?? null,   // null = unlimited
      assetCount: countRow?.n ?? 0,
    },
  });
}
