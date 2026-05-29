// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.4 — FCM push dispatch (C10 Option A: real-time for comments +
// shares; daily digest handles summaries separately).
//
// Routes/dispatch sites call the fire-and-forget helpers below AFTER their
// mutation has committed. Like the activity emitter, failures here MUST NOT
// bubble — a comment that posted is not worth failing because a push didn't
// send.
//
// GATING: sending requires FCM_SERVER_KEY (set on the joeybuilt env per ADR
// 0006). When unset, every send is a logged no-op so this whole module is
// safe to ship + deploy ahead of the Firebase operator gate. Token
// registration (lib + route + schema) works regardless.
//
// NOTE: this targets the FCM **legacy** HTTP endpoint (`Authorization: key=`)
// per the plan's FCM_SERVER_KEY contract. Google has been retiring legacy
// FCM; if sends start 401'ing post-Firebase-setup, swap `sendFcm` to the
// HTTP v1 API (service-account OAuth) — the token storage + dispatch fan-out
// here stay unchanged.

import { inArray, ne, and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";

const FCM_ENDPOINT = "https://fcm.googleapis.com/fcm/send";

export interface PushPayload {
  title: string;
  body: string;
  // Arbitrary string map delivered to the app for tap-routing (e.g.
  // { type: "comment", assetId } → mobile opens that asset's detail).
  data?: Record<string, string>;
}

function serverKey(): string | null {
  return process.env.FCM_SERVER_KEY || null;
}

type SendResult = "sent" | "unregistered" | "error" | "skipped";

// Send to a single token. Returns "unregistered" when FCM says the token is
// dead so the caller can prune it.
async function sendFcm(token: string, payload: PushPayload): Promise<SendResult> {
  const key = serverKey();
  if (!key) return "skipped";
  try {
    const res = await fetch(FCM_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `key=${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "fcm.send_http_error");
      return "error";
    }
    const json = (await res.json().catch(() => null)) as {
      results?: Array<{ error?: string }>;
    } | null;
    const err = json?.results?.[0]?.error;
    if (err === "NotRegistered" || err === "InvalidRegistration") {
      return "unregistered";
    }
    return err ? "error" : "sent";
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fcm.send_failed"
    );
    return "error";
  }
}

// Fire-and-forget push to a set of users. Loads every device token for the
// users, sends in parallel, and prunes any tokens FCM reports as dead.
// Never throws.
export async function dispatchPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<void> {
  try {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return;

    const rows = await db
      .select({ token: schema.pushTokens.token })
      .from(schema.pushTokens)
      .where(inArray(schema.pushTokens.userId, ids));
    if (rows.length === 0) return;

    if (!serverKey()) {
      logger.info(
        { recipients: ids.length, tokens: rows.length, kind: payload.data?.type },
        "fcm.skipped_no_server_key"
      );
      return;
    }

    const dead: string[] = [];
    await Promise.all(
      rows.map(async (r) => {
        const result = await sendFcm(r.token, payload);
        if (result === "unregistered") dead.push(r.token);
      })
    );

    if (dead.length > 0) {
      await db
        .delete(schema.pushTokens)
        .where(inArray(schema.pushTokens.token, dead));
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "fcm.dispatch_failed"
    );
  }
}

// Notify every member of a workspace, optionally excluding the actor who
// triggered the event (you don't get pinged for your own comment).
export async function notifyWorkspaceMembers(
  workspaceId: string,
  payload: PushPayload,
  options: { exceptUserId?: string } = {}
): Promise<void> {
  try {
    const where = options.exceptUserId
      ? and(
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          ne(schema.workspaceMemberships.userId, options.exceptUserId)
        )
      : eq(schema.workspaceMemberships.workspaceId, workspaceId);
    const members = await db
      .select({ userId: schema.workspaceMemberships.userId })
      .from(schema.workspaceMemberships)
      .where(where);
    await dispatchPushToUsers(
      members.map((m) => m.userId),
      payload
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "fcm.notify_workspace_failed"
    );
  }
}
