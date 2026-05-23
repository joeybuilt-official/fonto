// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// POST /api/v1/webhooks/:id/test — enqueue a synthetic `ping` event to the
// endpoint, regardless of its subscribed events list. Useful for verifying
// reachability + signature validation on the subscriber side.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { webhookDeliveryQueue, JobNames } from "@/lib/queue";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const workspaceId = workspaces[0].id;

  const { id } = await context.params;
  const [endpoint] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!endpoint) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const envelope = {
    id: randomUUID(),
    type: "ping" as const,
    createdAt: new Date().toISOString(),
    data: {
      message: "Fonto webhook test ping",
      ts: new Date().toISOString(),
    },
  };

  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      eventType: "ping",
      payload: envelope,
      state: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    })
    .returning({ id: schema.webhookDeliveries.id });

  await webhookDeliveryQueue().add(JobNames.DeliverWebhook, {
    deliveryId: delivery.id,
    attempt: 1,
  });

  return NextResponse.json({ deliveryId: delivery.id });
}
