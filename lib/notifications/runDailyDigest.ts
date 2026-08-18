// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — daily activity digest dispatcher.
//
// Tick:
//   1. Snapshot now() as `until`. Anything written after this point lands
//      in tomorrow's digest — no double-send.
//   2. For each workspace_memberships row:
//      a. Resolve cursor (last_event_at) or default to `until - 24h` for
//         a never-digested member (no backfill avalanche).
//      b. Pull activity_events for that workspace with
//         created_at > cursor AND created_at <= until.
//      c. Drop the actor's own events (you don't get a digest about
//         yourself).
//      d. Filter through notification_mutes — workspace-scope mute drops
//         everything; asset-scope mute drops only events whose target /
//         payload.assetId matches.
//      e. If lines is empty: advance cursor anyway so the next tick
//         doesn't re-scan the same window, then continue.
//      f. Otherwise: render lines, call sendDigestEmail, advance cursor.
//   3. Cursor write is the LAST step — if email-send throws we don't
//      advance, so the next tick retries the same window.
//
// All exits are best-effort: a single member that throws is logged + the
// loop continues. The job result counts dispatched / skipped / errored
// for observability.

import { db, schema } from "@/lib/db";
import { auth } from "@/lib/auth";
import type { User } from "@/lib/auth/types";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  renderDigestLines,
  renderDigestPlaintext,
} from "./renderDigest";
import { sendDigestEmail, type DigestEmailPayload } from "./digestEmail";

export interface DailyDigestResult {
  dispatched: number;
  emptyAdvances: number;
  errored: number;
  membersConsidered: number;
}

const DEFAULT_FIRST_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

function webBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? "http://localhost:3500";
  return raw.replace(/\/+$/, "");
}

async function loadUsersByIds(userIds: string[]): Promise<Map<string, User>> {
  const out = new Map<string, User>();
  if (userIds.length === 0) return out;
  try {
    const ctx = await auth.$context;
    for (const id of userIds) {
      const row = await ctx.adapter.findOne<Record<string, unknown>>({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (row) out.set(id, row as unknown as User);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "notifications.digest.user_lookup_failed"
    );
  }
  return out;
}

function displayName(user: User | undefined, fallbackId: string): string {
  if (!user) return fallbackId;
  const name = (user as { name?: string | null }).name;
  if (typeof name === "string" && name.trim().length > 0) return name;
  const email = (user as { email?: string | null }).email;
  if (typeof email === "string") {
    const local = email.split("@")[0];
    if (local) return local;
  }
  return fallbackId;
}

export async function runDailyDigest(): Promise<DailyDigestResult> {
  const result: DailyDigestResult = {
    dispatched: 0,
    emptyAdvances: 0,
    errored: 0,
    membersConsidered: 0,
  };
  const until = new Date();

  // Pull every (member, workspace) pair in one shot. Even at 100K
  // memberships this stays cheap — single index scan.
  const memberships = await db
    .select({
      userId: schema.workspaceMemberships.userId,
      workspaceId: schema.workspaceMemberships.workspaceId,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.workspaceMemberships)
    .innerJoin(
      schema.workspaces,
      eq(schema.workspaces.id, schema.workspaceMemberships.workspaceId)
    );

  result.membersConsidered = memberships.length;

  // Pre-resolve recipient user objects in one batch.
  const userMap = await loadUsersByIds(
    Array.from(new Set(memberships.map((m) => m.userId)))
  );

  for (const m of memberships) {
    try {
      const recipient = userMap.get(m.userId);
      if (!recipient || !(recipient as { email?: string }).email) {
        // No email = nothing to send. Don't advance the cursor — when the
        // user verifies an address later the window opens fresh.
        continue;
      }
      const recipientEmail = (recipient as { email: string }).email;

      // Cursor → fallback to 24h ago for first-time members so a freshly-
      // joined workspace doesn't dump everything-ever into their inbox.
      const [cursorRow] = await db
        .select({
          lastEventAt: schema.digestCursors.lastEventAt,
        })
        .from(schema.digestCursors)
        .where(
          and(
            eq(schema.digestCursors.userId, m.userId),
            eq(schema.digestCursors.workspaceId, m.workspaceId)
          )
        )
        .limit(1);

      const since =
        cursorRow?.lastEventAt ?? new Date(until.getTime() - DEFAULT_FIRST_DIGEST_WINDOW_MS);

      // Cheap early exit — the most common case for an unused workspace.
      if (since >= until) continue;

      const events = await db
        .select()
        .from(schema.activityEvents)
        .where(
          and(
            eq(schema.activityEvents.workspaceId, m.workspaceId),
            gt(schema.activityEvents.createdAt, since),
            lte(schema.activityEvents.createdAt, until)
          )
        )
        .orderBy(schema.activityEvents.createdAt);

      // Drop self-actor events.
      const otherActors = events.filter((e) => e.actorUserId !== m.userId);

      // Apply mutes.
      const mutes = await db
        .select()
        .from(schema.notificationMutes)
        .where(
          and(
            eq(schema.notificationMutes.userId, m.userId),
            eq(schema.notificationMutes.workspaceId, m.workspaceId)
          )
        );
      const workspaceMuted = mutes.some((mt) => mt.scopeType === "workspace");
      const mutedAssetIds = new Set(
        mutes.filter((mt) => mt.scopeType === "asset").map((mt) => mt.scopeId)
      );

      const filtered = workspaceMuted
        ? []
        : otherActors.filter((e) => {
            const payload = (e.payload ?? {}) as Record<string, unknown>;
            const assetId =
              (typeof payload.assetId === "string" ? payload.assetId : null) ??
              (e.targetType === "asset" ? e.targetId : null);
            return !assetId || !mutedAssetIds.has(assetId);
          });

      // Advance cursor regardless of content so we don't keep rescanning
      // the same empty window. `until` is authoritative — if we wrote
      // `max(event.createdAt)` instead we'd silently drop late-arriving
      // events that landed in the window between snapshot + commit.
      const newCursorAt = until;

      if (filtered.length === 0) {
        await upsertCursor(m.userId, m.workspaceId, newCursorAt);
        result.emptyAdvances++;
        continue;
      }

      // Resolve actor display names + asset filenames in batch for the
      // renderer.
      const actorIds = Array.from(
        new Set(filtered.map((e) => e.actorUserId).filter((v): v is string => !!v))
      );
      const actorUsers = await loadUsersByIds(actorIds);
      const actorDisplayName = new Map<string, string>();
      for (const id of actorIds) {
        actorDisplayName.set(id, displayName(actorUsers.get(id), id));
      }

      const assetIds = Array.from(
        new Set(
          filtered.flatMap((e) => {
            const payload = (e.payload ?? {}) as Record<string, unknown>;
            const ids: string[] = [];
            if (typeof payload.assetId === "string") ids.push(payload.assetId);
            if (e.targetType === "asset" && e.targetId) ids.push(e.targetId);
            return ids;
          })
        )
      );
      const assetRows = assetIds.length
        ? await db
            .select({
              id: schema.assets.id,
              filename: schema.assets.filename,
            })
            .from(schema.assets)
            .where(inArray(schema.assets.id, assetIds))
        : [];
      const assetFilename = new Map(assetRows.map((a) => [a.id, a.filename]));

      const base = webBaseUrl();
      const lines = renderDigestLines({
        events: filtered,
        actorDisplayName,
        assetFilename,
        webBaseUrl: base,
      });

      const payload: DigestEmailPayload = {
        to: recipientEmail,
        workspaceName: m.workspaceName,
        recipientName: displayName(recipient, recipientEmail.split("@")[0] ?? "there"),
        since,
        until,
        lines,
        bodyPlaintext: renderDigestPlaintext({
          recipientName: displayName(recipient, recipientEmail.split("@")[0] ?? "there"),
          workspaceName: m.workspaceName,
          since,
          until,
          lines,
          preferencesUrl: `${base}/app/settings/notifications`,
        }),
        preferencesUrl: `${base}/app/settings/notifications`,
      };

      await sendDigestEmail(payload);
      await upsertCursor(m.userId, m.workspaceId, newCursorAt);
      result.dispatched++;
    } catch (err) {
      result.errored++;
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          userId: m.userId,
          workspaceId: m.workspaceId,
        },
        "notifications.digest.member_failed"
      );
    }
  }

  logger.info(result, "notifications.digest.tick_complete");
  return result;
}

async function upsertCursor(
  userId: string,
  workspaceId: string,
  lastEventAt: Date
): Promise<void> {
  // Drizzle's onConflictDoUpdate uses the unique index columns; the
  // composite (user_id, workspace_id) index is declared in schema.ts.
  await db
    .insert(schema.digestCursors)
    .values({
      userId,
      workspaceId,
      lastEventAt,
      lastSentAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.digestCursors.userId, schema.digestCursors.workspaceId],
      set: {
        lastEventAt,
        lastSentAt: sql`now()`,
      },
    });
}
