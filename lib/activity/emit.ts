// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — workspace activity feed emitter.
//
// Single entry point for writing fonto.activity_events rows. Routes call
// this fire-and-forget after the underlying mutation has succeeded. The
// daily digest worker (lib/notifications/digest.ts) consumes the table.
//
// Failures here MUST NOT bubble — a comment that posted successfully is
// not worth rolling back because we couldn't write a feed entry. The
// emitter logs and swallows.

import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";

export type ActivityKind =
  | "comment.posted"
  | "comment.deleted"
  | "asset.uploaded";

export interface EmitActivityInput {
  workspaceId: string;
  actorUserId: string | null;
  kind: ActivityKind;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export async function emitActivity(input: EmitActivityInput): Promise<void> {
  try {
    await db.insert(schema.activityEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      payload: input.payload ?? {},
    });
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        kind: input.kind,
        workspaceId: input.workspaceId,
      },
      "activity_events.emit_failed"
    );
  }
}
