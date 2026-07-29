// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — clients (the optional parent of professional shoots).
//
//   GET  /api/v1/clients                -> { clients: [...] } ordered by name
//   POST /api/v1/clients   { name, notes? }   -> { client }   (editor+)
//   PATCH /api/v1/clients  { id, name?, notes? } -> { client } (editor+)
//   DELETE /api/v1/clients { id }       -> { ok }              (editor+)
//
// Soft-FK semantics: deleting a client does NOT cascade onto its shoots
// (`shoots.client_id` is a soft FK in schema.ts:579). The client row goes
// away; shoots that referenced it are surfaced as hobby shoots in the
// browser UI. This is intentional — a deleted client should not delete
// a shoot's photos.
//
// T1.3 (fonto-perf-audit.md) — class-B workspace-scoped catalogue. GET is
// wrapped in `unstable_cache` keyed by workspaceId and tagged with
// `ws:<id>:clients`; the matching POST/PATCH/DELETE call `revalidateTag`
// on success so cached responses evict immediately. See CACHE-CONVENTION.md.
export const revalidate = 300;

import { NextRequest, NextResponse } from "next/server";
import { unstable_cache, revalidateTag } from "next/cache";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

const loadClients = (workspaceId: string) =>
  unstable_cache(
    async () =>
      db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.workspaceId, workspaceId))
        .orderBy(schema.clients.name),
    ["clients-list", workspaceId],
    { tags: [`ws:${workspaceId}:clients`], revalidate: 300 }
  )();

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ clients: [] });
  const workspaceId = workspaces[0].id;

  const clients = await loadClients(workspaceId);

  return NextResponse.json({ clients });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; notes?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "`name` is required" }, { status: 400 });
  const notes = typeof body?.notes === "string" ? body.notes : "";

  const [client] = await db
    .insert(schema.clients)
    .values({ workspaceId, userId: user.id, name, notes })
    .returning();

  revalidateTag(`ws:${workspaceId}:clients`, "max");
  return NextResponse.json({ client }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceId = workspaces[0].id;

  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; name?: unknown; notes?: unknown }
    | null;
  if (typeof body?.id !== "string" || body.id === "") {
    return NextResponse.json({ error: "`id` is required" }, { status: 400 });
  }
  const patch: Partial<typeof schema.clients.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (!trimmed) return NextResponse.json({ error: "`name` cannot be empty" }, { status: 400 });
    patch.name = trimmed;
  }
  if (typeof body.notes === "string") patch.notes = body.notes;

  const [client] = await db
    .update(schema.clients)
    .set(patch)
    .where(and(eq(schema.clients.id, body.id), eq(schema.clients.workspaceId, workspaceId)))
    .returning();

  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });
  revalidateTag(`ws:${workspaceId}:clients`, "max");
  return NextResponse.json({ client });
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

  const res = await db
    .delete(schema.clients)
    .where(and(eq(schema.clients.id, body.id), eq(schema.clients.workspaceId, workspaceId)))
    .returning({ id: schema.clients.id });

  if (res.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  revalidateTag(`ws:${workspaceId}:clients`, "max");
  return NextResponse.json({ ok: true });
}
