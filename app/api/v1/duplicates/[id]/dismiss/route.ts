// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — dismiss a duplicate group ("not duplicates, keep all"). Marks the
// group status='confirmed' WITHOUT trashing any member (canonicalAssetId stays
// null). That keeps it out of the candidate queue AND stops the seeder
// (populateVariantCandidatesForWorkspace, which skips confirmed/consolidated
// members) from resurfacing it. The absence of any trashed member is what
// distinguishes a dismissed group from a consolidated one.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const updated = await db
    .update(schema.variantGroups)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(
      and(
        eq(schema.variantGroups.id, id),
        eq(schema.variantGroups.status, "candidate"),
        inArray(
          schema.variantGroups.workspaceId,
          workspaces.map((w) => w.id),
        ),
      ),
    )
    .returning({ id: schema.variantGroups.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ groupId: id, dismissed: true });
}
