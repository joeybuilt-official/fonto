// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 — undo a bulk scope reassignment batch.
//
//   POST /api/v1/scope/reassign/undo
//     Body: { batchId: string }
//     Returns { restored }.
//
// Restores each asset in the batch to its recorded from_scope / from_shoot_id,
// bumps seq so clients re-sync, then deletes the batch's ledger rows (a clean
// undo — the batchId can be reused afterwards).
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { nextSeq } from "@/lib/db/seq";
import { resolveUndoRestore } from "@/lib/scope";
import { cacheInvalidate } from "@/lib/cache/valkey";

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { batchId?: unknown } | null;
  if (typeof body?.batchId !== "string" || body.batchId.trim() === "") {
    return NextResponse.json({ error: "`batchId` is required" }, { status: 400 });
  }
  const batchId = body.batchId.trim();

  const ledger = await db
    .select()
    .from(schema.scopeReassignments)
    .where(
      and(
        eq(schema.scopeReassignments.workspaceId, workspaceId),
        eq(schema.scopeReassignments.batchId, batchId)
      )
    );

  if (ledger.length === 0) {
    return NextResponse.json({ error: "No such batch in this workspace" }, { status: 404 });
  }

  // Guard the dangling-shoot edge: a batch produced by a shoot DELETE records
  // from_shoot_id = <the deleted shoot>. Restoring that id would re-orphan the
  // asset (SHOOT-scoped, pointing at a shoot that no longer exists). So for any
  // recorded from_shoot_id whose shoot is gone, drop the shoot_id on restore
  // and keep the asset PERSONAL rather than re-filing it into nothing.
  const wantShootIds = [
    ...new Set(ledger.map((r) => r.fromShootId).filter((x): x is string => !!x)),
  ];
  const liveShootIds = new Set<string>();
  if (wantShootIds.length > 0) {
    const live = await db
      .select({ id: schema.shoots.id })
      .from(schema.shoots)
      .where(
        and(
          eq(schema.shoots.workspaceId, workspaceId),
          inArray(schema.shoots.id, wantShootIds)
        )
      );
    for (const s of live) liveShootIds.add(s.id);
  }

  let restored = 0;
  let skippedDeletedShoot = 0;
  for (const r of ledger) {
    const target = resolveUndoRestore(r.fromScope, r.fromShootId, liveShootIds);
    if (r.fromShootId != null && target.shootId == null) skippedDeletedShoot += 1;
    const seq = await nextSeq(workspaceId, "asset");
    await db
      .update(schema.assets)
      .set({ scope: target.scope, shootId: target.shootId, seq, updatedAt: new Date() })
      .where(eq(schema.assets.id, r.assetId));
    restored += 1;
  }

  await db
    .delete(schema.scopeReassignments)
    .where(
      and(
        eq(schema.scopeReassignments.workspaceId, workspaceId),
        eq(schema.scopeReassignments.batchId, batchId)
      )
    );

  if (restored > 0) {
    // T1.3' — evict every aggregate cache that embeds asset rows/counts.
    revalidateTag(`ws:${workspaceId}:assets`, "max");
    void cacheInvalidate(`ws:${workspaceId}:assets`);
  }

  return NextResponse.json({ restored, ...(skippedDeletedShoot > 0 ? { keptPersonalForDeletedShoot: skippedDeletedShoot } : {}) });
}
