// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, ne, count } from "drizzle-orm";
import { mirrorCoverage } from "@/lib/storage/coverage";
import { isStoragePolicy } from "@/lib/storage/policy";

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

  // Phase B6 (storage placement) — surface the effective placement policy +
  // mirror coverage so Settings → Storage can render the picker + progress.
  // `localBytes` is the separate NAS-disk figure (C3), distinct from quota.
  const coverage = await mirrorCoverage(workspace.id);

  return NextResponse.json({
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    storage: {
      usageBytes: ws?.usageBytes ?? 0,
      quotaBytes: ws?.quotaBytes ?? null,   // null = unlimited
      assetCount: countRow?.n ?? 0,
      policy: coverage.policy,
      mirror: {
        eligible: coverage.eligible,
        mirrored: coverage.mirrored,
        localBytes: coverage.localBytes,
      },
    },
  });
}

// Phase B6 (storage placement) — set the workspace's storage-placement policy.
// Owner-only (it's a workspace setting). C4: `local_only` is DEFERRED this
// initiative, so only `r2_only` + `mirror` are selectable; the resolver still
// understands local_only for forward-compat but no UI/API produces it yet.
const SELECTABLE_POLICIES = ["r2_only", "mirror"] as const;

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspace = workspaces[0];

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspace.id, "owner");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { storagePolicy?: unknown } | null;
  const next = body?.storagePolicy;
  if (!isStoragePolicy(next) || !(SELECTABLE_POLICIES as readonly string[]).includes(next)) {
    return NextResponse.json(
      { error: `storagePolicy must be one of ${SELECTABLE_POLICIES.join(", ")}` },
      { status: 400 }
    );
  }

  await db
    .update(schema.workspaces)
    .set({ storagePolicy: next })
    .where(eq(schema.workspaces.id, workspace.id));

  return NextResponse.json({ storagePolicy: next });
}
