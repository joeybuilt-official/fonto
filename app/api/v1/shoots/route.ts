// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — shoots (one deliberate session).
//
//   GET  /api/v1/shoots
//          ?clientId=<uuid>  -> only that client's shoots
//          ?clientId=null    -> hobby shoots (NULL client_id)
//          (no param)        -> all shoots in workspace
//        Returns { shoots: [...] } with per-shoot asset counts grouped by stage.
//   POST /api/v1/shoots   { name, clientId?, shootDate?, kind?, paid?, consentStatus? }
//          -> { shoot }   (editor+)
//   PATCH /api/v1/shoots  { id, ... }   -> { shoot }   (editor+)
//   DELETE /api/v1/shoots { id }   -> { ok, revertedAssets, batchId? }  (editor+)
//
// Delete semantics (ADR 0008): deleting a shoot reverts every asset filed into
// it back to scope='PERSONAL' (clearing shoot_id + shoot_stage) so the photos
// return to the personal timeline rather than becoming orphaned (SHOOT-scoped
// but pointing at a deleted shoot = invisible everywhere). The revert is logged
// to scope_reassignments under one batch and is reflected in `revertedAssets` +
// `batchId`. Other soft-FKs (correspondents / stacks) keep dangling-on-delete
// semantics; shoots are special-cased because scope makes orphaning user-visible.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { nextSeq } from "@/lib/db/seq";
import { isShootStage, type ShootStage } from "@/lib/scope";

interface ShootWithCounts {
  id: string;
  workspaceId: string;
  userId: string;
  clientId: string | null;
  name: string;
  shootDate: string | null;
  kind: string | null;
  paid: boolean;
  consentStatus: string | null;
  createdAt: string;
  updatedAt: string;
  counts: Record<ShootStage | "UNSTAGED" | "total", number>;
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ shoots: [] });
  const workspaceId = workspaces[0].id;

  const url = new URL(request.url);
  const clientFilter = url.searchParams.get("clientId");

  const where = [eq(schema.shoots.workspaceId, workspaceId)];
  if (clientFilter === "null") where.push(isNull(schema.shoots.clientId));
  else if (clientFilter) where.push(eq(schema.shoots.clientId, clientFilter));

  const shoots = await db
    .select()
    .from(schema.shoots)
    .where(and(...where))
    .orderBy(sql`${schema.shoots.shootDate} desc nulls last`, schema.shoots.name);

  if (shoots.length === 0) return NextResponse.json({ shoots: [] });

  const countRows = (await db.execute(sql`
    SELECT shoot_id, shoot_stage, COUNT(*)::int AS n
      FROM fonto.assets
     WHERE workspace_id = ${workspaceId}
       AND scope = 'SHOOT'
       AND deleted_at IS NULL
       AND shoot_id IS NOT NULL
     GROUP BY shoot_id, shoot_stage
  `)) as unknown as Array<{ shoot_id: string; shoot_stage: string | null; n: number }>;

  const byShoot = new Map<string, ShootWithCounts["counts"]>();
  for (const r of countRows) {
    const bucket = byShoot.get(r.shoot_id) ?? {
      RAW: 0,
      SELECTS: 0,
      DELIVERED: 0,
      REJECTS: 0,
      UNSTAGED: 0,
      total: 0,
    };
    const stage = r.shoot_stage;
    if (isShootStage(stage)) bucket[stage] += r.n;
    else bucket.UNSTAGED += r.n;
    bucket.total += r.n;
    byShoot.set(r.shoot_id, bucket);
  }

  const result: ShootWithCounts[] = shoots.map((s) => ({
    ...s,
    shootDate: s.shootDate as string | null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    counts:
      byShoot.get(s.id) ?? {
        RAW: 0,
        SELECTS: 0,
        DELIVERED: 0,
        REJECTS: 0,
        UNSTAGED: 0,
        total: 0,
      },
  }));

  return NextResponse.json({ shoots: result });
}

interface CreateBody {
  name?: unknown;
  clientId?: unknown;
  shootDate?: unknown;
  kind?: unknown;
  paid?: unknown;
  consentStatus?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as CreateBody | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "`name` is required" }, { status: 400 });

  const clientId = typeof body?.clientId === "string" && body.clientId ? body.clientId : null;
  if (clientId) {
    const [exists] = await db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(and(eq(schema.clients.id, clientId), eq(schema.clients.workspaceId, workspaceId)))
      .limit(1);
    if (!exists) return NextResponse.json({ error: "Client not found" }, { status: 400 });
  }

  const shootDate = typeof body?.shootDate === "string" && body.shootDate ? body.shootDate : null;
  const kind = typeof body?.kind === "string" && body.kind ? body.kind : null;
  const paid = body?.paid === true;
  const consentStatus =
    typeof body?.consentStatus === "string" && body.consentStatus ? body.consentStatus : null;

  const [shoot] = await db
    .insert(schema.shoots)
    .values({
      workspaceId,
      userId: user.id,
      clientId,
      name,
      shootDate,
      kind,
      paid,
      consentStatus,
    })
    .returning();

  return NextResponse.json({ shoot }, { status: 201 });
}

interface PatchBody {
  id?: unknown;
  name?: unknown;
  clientId?: unknown;
  shootDate?: unknown;
  kind?: unknown;
  paid?: unknown;
  consentStatus?: unknown;
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (typeof body?.id !== "string" || body.id === "") {
    return NextResponse.json({ error: "`id` is required" }, { status: 400 });
  }

  const patch: Partial<typeof schema.shoots.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (!trimmed) return NextResponse.json({ error: "`name` cannot be empty" }, { status: 400 });
    patch.name = trimmed;
  }
  if ("clientId" in body) {
    // explicit null => clear; otherwise validate ownership
    const v = body.clientId;
    if (v === null) patch.clientId = null;
    else if (typeof v === "string" && v) {
      const [exists] = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.id, v), eq(schema.clients.workspaceId, workspaceId)))
        .limit(1);
      if (!exists) return NextResponse.json({ error: "Client not found" }, { status: 400 });
      patch.clientId = v;
    }
  }
  if (typeof body.shootDate === "string" || body.shootDate === null) {
    patch.shootDate = (body.shootDate as string | null) || null;
  }
  if (typeof body.kind === "string" || body.kind === null) {
    patch.kind = (body.kind as string | null) || null;
  }
  if (typeof body.paid === "boolean") patch.paid = body.paid;
  if (typeof body.consentStatus === "string" || body.consentStatus === null) {
    patch.consentStatus = (body.consentStatus as string | null) || null;
  }

  const [shoot] = await db
    .update(schema.shoots)
    .set(patch)
    .where(and(eq(schema.shoots.id, body.id), eq(schema.shoots.workspaceId, workspaceId)))
    .returning();

  if (!shoot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ shoot });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || body.id === "") {
    return NextResponse.json({ error: "`id` is required" }, { status: 400 });
  }

  // Confirm the shoot exists in this workspace before touching its assets.
  const [shootRow] = await db
    .select({ id: schema.shoots.id })
    .from(schema.shoots)
    .where(and(eq(schema.shoots.id, body.id), eq(schema.shoots.workspaceId, workspaceId)))
    .limit(1);
  if (!shootRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ADR 0008 — deleting a shoot must NOT orphan its photos. Any asset filed
  // into this shoot is reverted to scope='PERSONAL' (shoot_id + shoot_stage
  // cleared) so it returns to the personal timeline rather than becoming
  // invisible (SHOOT-scoped but pointing at a now-deleted shoot). The revert
  // is logged to scope_reassignments under one batch (auditable; the undo
  // route guards against the deleted-shoot dangling-ref edge). seq is bumped
  // so clients re-sync the change.
  const affected = await db
    .select({ id: schema.assets.id, scope: schema.assets.scope })
    .from(schema.assets)
    .where(and(eq(schema.assets.workspaceId, workspaceId), eq(schema.assets.shootId, body.id)));

  const batchId = randomUUID();
  let revertedAssets = 0;
  for (const a of affected) {
    const seq = await nextSeq(workspaceId, "asset");
    await db
      .update(schema.assets)
      .set({ scope: "PERSONAL", shootId: null, shootStage: null, seq, updatedAt: new Date() })
      .where(eq(schema.assets.id, a.id));
    await db
      .insert(schema.scopeReassignments)
      .values({
        workspaceId,
        assetId: a.id,
        batchId,
        fromScope: a.scope,
        toScope: "PERSONAL",
        fromShootId: body.id,
        toShootId: null,
        actor: user.id,
      })
      .onConflictDoNothing();
    revertedAssets += 1;
  }

  await db
    .delete(schema.shoots)
    .where(and(eq(schema.shoots.id, body.id), eq(schema.shoots.workspaceId, workspaceId)));

  return NextResponse.json({
    ok: true,
    revertedAssets,
    ...(revertedAssets > 0 ? { batchId } : {}),
  });
}
