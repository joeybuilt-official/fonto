// SPDX-License-Identifier: MIT
// Inbound event handler — Plexo pushes events to connected apps via this endpoint.
// Stub handlers for cross-app event subscriptions.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Same service-key trust boundary as /api/plexo/data — this is an inbound write
// surface (log injection now, real side effects once the stubs land), so it must
// not be anonymous. Constant-time compare over equal-length Buffers.
function isServiceKeyRequest(req: NextRequest): boolean {
  const svcKey = process.env.PLEXO_SERVICE_KEY;
  const rawToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!svcKey || !rawToken) return false;
  const a = Buffer.from(rawToken);
  const b = Buffer.from(svcKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

const plexoEventSchema = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  workspaceId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  if (!isServiceKeyRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = plexoEventSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { eventType, payload } = parsed.data;

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
