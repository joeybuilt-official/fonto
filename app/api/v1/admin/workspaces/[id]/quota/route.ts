// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — get/set a workspace's storage quota. Instance-admin only.
// quotaBytes null = unlimited. The existing upload path enforces the cap
// ("Storage quota exceeded"); this just sets the number.
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireInstanceAdmin } from "@/lib/authz/instance";

async function loadWorkspace(id: string) {
  const [ws] = await db
    .select({
      id: schema.workspaces.id,
      quotaBytes: schema.workspaces.quotaBytes,
      usageBytes: schema.workspaces.usageBytes,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, id))
    .limit(1);
  return ws ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const ws = await loadWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ quotaBytes: ws.quotaBytes, usageBytes: ws.usageBytes });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { quotaBytes?: unknown };
  // Coerce: null / "" / absent → unlimited (NULL). A finite non-negative number
  // → that cap. Anything else → 400.
  let quotaBytes: number | null;
  const raw = body.quotaBytes;
  if (raw == null || raw === "") {
    quotaBytes = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "quotaBytes must be a non-negative number or null" }, { status: 400 });
    }
    quotaBytes = Math.floor(n);
  }

  const ws = await loadWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .update(schema.workspaces)
    .set({ quotaBytes })
    .where(eq(schema.workspaces.id, id));

  return NextResponse.json({ quotaBytes, usageBytes: ws.usageBytes });
}
