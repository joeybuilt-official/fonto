// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Single-endpoint management: PATCH (update url, events, description,
// enabled/disabled state) and DELETE. The signing secret is intentionally
// NOT modifiable here — rotation would silently break subscribers, so a
// future "rotate" route should require explicit confirmation.

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { isWebhookEventType, SubscribableEventTypes } from "@/lib/webhooks/events";

const PatchBody = z.object({
  url: z.string().url().optional(),
  enabledEvents: z.array(z.string()).optional(),
  description: z.string().max(500).nullable().optional(),
  // true = enable, false = disable. Omitted = leave unchanged.
  enabled: z.boolean().optional(),
});

function publicEndpoint(row: typeof schema.webhookEndpoints.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    enabledEvents: row.enabledEvents,
    description: row.description,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadOwned(
  id: string,
  workspaceId: string
): Promise<typeof schema.webhookEndpoints.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceId = workspaces[0].id;

  const { id } = await context.params;
  const existing = await loadOwned(id, workspaceId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Phase 3.1 — editor required to modify webhook endpoints.
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const parsed = PatchBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updates: Partial<typeof schema.webhookEndpoints.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.url !== undefined) updates.url = parsed.data.url;
  if (parsed.data.description !== undefined)
    updates.description = parsed.data.description;
  if (parsed.data.enabledEvents !== undefined) {
    const invalid = parsed.data.enabledEvents.filter(
      (e) => !isWebhookEventType(e) || e === "ping"
    );
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "unknown_events", invalid, valid: SubscribableEventTypes },
        { status: 400 }
      );
    }
    updates.enabledEvents = parsed.data.enabledEvents as string[];
  }
  if (parsed.data.enabled !== undefined) {
    updates.disabledAt = parsed.data.enabled ? null : new Date();
  }

  const [row] = await db
    .update(schema.webhookEndpoints)
    .set(updates)
    .where(eq(schema.webhookEndpoints.id, id))
    .returning();

  return NextResponse.json({ endpoint: publicEndpoint(row) });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceId = workspaces[0].id;

  const { id } = await context.params;
  const existing = await loadOwned(id, workspaceId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Phase 3.1 — editor required to delete webhook endpoints.
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  // Cascade-delete pending deliveries for this endpoint. Past deliveries
  // (delivered/failed) are kept for audit; pending ones would otherwise
  // produce zombie POSTs.
  await db
    .delete(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.endpointId, id),
        eq(schema.webhookDeliveries.state, "pending")
      )
    );

  await db
    .delete(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, id));

  return NextResponse.json({ ok: true });
}
