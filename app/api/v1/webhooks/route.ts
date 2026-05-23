// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Webhook endpoint management API. Lists endpoints, creates new ones (with
// a single-show signing-secret reveal in the response), and validates the
// `enabledEvents` array against the canonical event taxonomy.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { isWebhookEventType, SubscribableEventTypes } from "@/lib/webhooks/events";

const CreateBody = z.object({
  url: z.string().url(),
  enabledEvents: z.array(z.string()).default([]),
  description: z.string().max(500).optional(),
});

/** Strip the signingSecret from list responses; secrets are only ever
 *  returned at create time. */
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

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ endpoints: [] });
  const workspaceId = workspaces[0].id;

  const rows = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.workspaceId, workspaceId))
    .orderBy(schema.webhookEndpoints.createdAt);

  return NextResponse.json({ endpoints: rows.map(publicEndpoint) });
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace found" }, { status: 400 });
  }
  const workspaceId = workspaces[0].id;

  // Phase 3.1 — editor required to create webhook endpoints. The plan's open
  // question of admin-vs-editor was decided in favour of editor per ADR 0004
  // (no role beyond owner/editor/viewer ships in 3.1).
  const gate = await requireWorkspaceAccessOrResponse(user.id, workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const parsed = CreateBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { url, enabledEvents, description } = parsed.data;

  // Validate event names against the canonical taxonomy.
  const invalid = enabledEvents.filter((e) => !isWebhookEventType(e) || e === "ping");
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: "unknown_events", invalid, valid: SubscribableEventTypes },
      { status: 400 }
    );
  }

  // 32-byte random hex (64 chars).
  const signingSecret = randomBytes(32).toString("hex");

  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      workspaceId,
      url,
      signingSecret,
      enabledEvents: enabledEvents as string[],
      description: description ?? null,
    })
    .returning();

  // Single-show secret reveal: only return the secret on this response.
  // Subsequent GETs will not include it.
  return NextResponse.json(
    {
      endpoint: publicEndpoint(endpoint),
      signingSecret,
    },
    { status: 201 }
  );
}
