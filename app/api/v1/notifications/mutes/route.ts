// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — per-user notification mute toggles.
//
//   GET  /api/v1/notifications/mutes[?workspaceId=...]
//     Returns the caller's mutes in the given (or first) workspace.
//   POST /api/v1/notifications/mutes
//     Body: { workspaceId, scopeType: 'asset'|'workspace', scopeId }
//     Idempotent insert: muting twice is a no-op.
//   DELETE /api/v1/notifications/mutes
//     Body: { workspaceId, scopeType, scopeId }
//     Idempotent: unmuting an already-unmuted scope returns 204.
//
// Authz: caller must have any membership on the workspace (viewer is
// enough — every member chooses their own digest preferences).

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaceRole } from "@/lib/authz";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

type ScopeType = "asset" | "workspace";

function parseScopeType(value: unknown): ScopeType | null {
  return value === "asset" || value === "workspace" ? value : null;
}

export async function GET(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  let workspaceId = searchParams.get("workspaceId");
  if (!workspaceId) {
    const workspaces = await getUserWorkspaces(user.id);
    if (!workspaces.length) return NextResponse.json({ mutes: [] });
    workspaceId = workspaces[0].id;
  }

  const role = await getUserWorkspaceRole(user.id, workspaceId);
  if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(schema.notificationMutes)
    .where(
      and(
        eq(schema.notificationMutes.userId, user.id),
        eq(schema.notificationMutes.workspaceId, workspaceId)
      )
    );

  return NextResponse.json({
    mutes: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

interface MuteBody {
  workspaceId?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
}

async function readMuteBody(request: NextRequest): Promise<
  | { ok: true; workspaceId: string; scopeType: ScopeType; scopeId: string }
  | { ok: false; response: NextResponse }
> {
  const body = (await request.json().catch(() => null)) as MuteBody | null;
  if (!body || typeof body.workspaceId !== "string" || typeof body.scopeId !== "string") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "workspaceId + scopeId required" },
        { status: 400 }
      ),
    };
  }
  const scopeType = parseScopeType(body.scopeType);
  if (!scopeType) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "scopeType must be 'asset' or 'workspace'" },
        { status: 400 }
      ),
    };
  }
  // Workspace-scope mute requires scopeId === workspaceId (matches the
  // CHECK constraint in migration 0027).
  if (scopeType === "workspace" && body.scopeId !== body.workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "workspace-scope mute must use workspaceId as scopeId" },
        { status: 400 }
      ),
    };
  }
  return {
    ok: true,
    workspaceId: body.workspaceId,
    scopeType,
    scopeId: body.scopeId,
  };
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMuteBody(request);
  if (!parsed.ok) return parsed.response;

  const role = await getUserWorkspaceRole(user.id, parsed.workspaceId);
  if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .insert(schema.notificationMutes)
    .values({
      userId: user.id,
      workspaceId: parsed.workspaceId,
      scopeType: parsed.scopeType,
      scopeId: parsed.scopeId,
    })
    .onConflictDoNothing();

  return new NextResponse(null, { status: 204 });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await readMuteBody(request);
  if (!parsed.ok) return parsed.response;

  const role = await getUserWorkspaceRole(user.id, parsed.workspaceId);
  if (!role) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .delete(schema.notificationMutes)
    .where(
      and(
        eq(schema.notificationMutes.userId, user.id),
        eq(schema.notificationMutes.workspaceId, parsed.workspaceId),
        eq(schema.notificationMutes.scopeType, parsed.scopeType),
        eq(schema.notificationMutes.scopeId, parsed.scopeId)
      )
    );

  return new NextResponse(null, { status: 204 });
}
