// SPDX-License-Identifier: MIT
// Inbound event handler — Plexo pushes events to connected apps via this endpoint.
// Stub handlers for cross-app event subscriptions.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

type PlexoEvent = {
  eventType: string;
  payload: Record<string, unknown>;
  workspaceId?: string;
};

export async function POST(request: NextRequest) {
  let body: PlexoEvent;
  try {
    body = (await request.json()) as PlexoEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { eventType, payload } = body;

  switch (eventType) {
    case "ext.plexo.task.resolved":
      // Stub: log task resolution for future cross-app workflow
      console.info("[fonto/events] ext.plexo.task.resolved — no-op stub", {
        taskId: payload.taskId,
      });
      break;

    case "ext.nexalog.fragment.archived":
      // Stub: when a Nexalog fragment is archived, it may reference a Fonto asset
      // Future: mark related asset as archivable
      console.info("[fonto/events] ext.nexalog.fragment.archived — no-op stub", {
        fragmentId: payload.fragmentId,
        assetId: payload.assetId,
      });
      break;

    default:
      // Unknown event — accept but ignore
      break;
  }

  return NextResponse.json({ ok: true });
}
