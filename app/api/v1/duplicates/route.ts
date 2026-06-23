// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — user-facing duplicates review. LIGHTWEIGHT list of candidate
// near-duplicate groups (fonto.variant_groups, status='candidate') with their
// active member assets. Deliberately does NOT run the SSIM buildGroupManifest
// per group (that ~50s tail stays the owner-only Tidy Up admin lane) — the
// stored grouping + member thumbnails are enough for the routine surface.
//
// Resolve/dismiss live in ./[id]/resolve and ./[id]/dismiss.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { serializeAsset } from "@/lib/assets/createAssetRow";

const MAX_GROUPS = 100;

export async function GET(): Promise<NextResponse> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ groups: [] });
  const workspaceId = workspaces[0].id;

  const candidateGroups = await db
    .select({
      id: schema.variantGroups.id,
      confidence: schema.variantGroups.groupingConfidence,
    })
    .from(schema.variantGroups)
    .where(
      and(
        eq(schema.variantGroups.workspaceId, workspaceId),
        eq(schema.variantGroups.status, "candidate"),
      ),
    )
    .orderBy(schema.variantGroups.createdAt)
    .limit(MAX_GROUPS);

  if (candidateGroups.length === 0) return NextResponse.json({ groups: [] });

  const groupIds = candidateGroups.map((g) => g.id);

  // Pull all members in one query, then bucket by group. Only active, not-yet-
  // consolidated rows — a half-resolved group shouldn't show its trashed dupes.
  const members = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.variantGroupId, groupIds),
        eq(schema.assets.lifecycleState, "active"),
        ne(schema.assets.consolidationState, "trashed"),
      ),
    );

  const byGroup = new Map<string, ReturnType<typeof serializeAsset>[]>();
  for (const row of members) {
    const gid = row.variantGroupId;
    if (!gid) continue;
    const bucket = byGroup.get(gid);
    if (bucket) bucket.push(serializeAsset(row));
    else byGroup.set(gid, [serializeAsset(row)]);
  }

  const groups = candidateGroups
    .map((g) => ({
      groupId: g.id,
      confidence: g.confidence,
      members: byGroup.get(g.id) ?? [],
    }))
    // A group needs ≥2 live members to be worth reviewing — a single survivor
    // (the rest already resolved elsewhere) is not a duplicate set anymore.
    .filter((g) => g.members.length >= 2);

  return NextResponse.json({ groups });
}
