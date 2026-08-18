// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// GET /api/v1/webhooks/:id/deliveries — recent delivery log. Hard-capped at
// 200 rows per request via the `limit` query param (default 50) so a
// runaway client can't drag down a workspace with millions of rows.

import { NextRequest, NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ deliveries: [] });
  const workspaceId = workspaces[0].id;

  const { id } = await context.params;

  // Confirm ownership before returning delivery rows.
  const [endpoint] = await db
    .select({ id: schema.webhookEndpoints.id })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!endpoint) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const url = new URL(request.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.max(1, Math.min(Number.isFinite(limitParam) ? limitParam : 50, 200));

  const rows = await db
    .select({
      id: schema.webhookDeliveries.id,
      eventType: schema.webhookDeliveries.eventType,
      state: schema.webhookDeliveries.state,
      attempts: schema.webhookDeliveries.attempts,
      lastAttemptAt: schema.webhookDeliveries.lastAttemptAt,
      nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      lastResponseStatus: schema.webhookDeliveries.lastResponseStatus,
      lastResponseBody: schema.webhookDeliveries.lastResponseBody,
      createdAt: schema.webhookDeliveries.createdAt,
    })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.endpointId, id))
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(limit);

  return NextResponse.json({
    deliveries: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      state: r.state,
      attempts: r.attempts,
      lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
      nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
      lastResponseStatus: r.lastResponseStatus,
      lastResponseBody: r.lastResponseBody,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
