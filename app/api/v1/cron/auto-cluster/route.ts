// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M15 closeout — nightly HNSW face auto-cluster cron endpoint.
// Called by an external cron (NAS /etc/cron.d/root) at 02:00 daily.
// Enqueues one AutoClusterFaces job per workspace that has face data.
// Protected by X-Cron-Secret header matching CRON_SECRET env var.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { addAutoClusterFacesJob } from "@/lib/queue/queues";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("X-Cron-Secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find every workspace that has at least one embedded, non-hidden face.
  const workspaces = await db
    .selectDistinct({ workspaceId: schema.faceInstances.workspaceId })
    .from(schema.faceInstances)
    .where(
      sql`${schema.faceInstances.hidden} = false
        AND ${schema.faceInstances.embedding} IS NOT NULL`
    );

  const enqueued: string[] = [];
  for (const { workspaceId } of workspaces) {
    const id = await addAutoClusterFacesJob({ workspaceId });
    if (id) enqueued.push(workspaceId);
  }

  return NextResponse.json({ enqueued: enqueued.length, workspaces: enqueued });
}
