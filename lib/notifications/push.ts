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
// GATING: sending requires FIREBASE_SERVICE_ACCOUNT_JSON (the firebase-adminsdk
// service-account key, as a single-line JSON string, set on the worker env).
// When unset, every send is a logged no-op so this whole module stays safe to
// ship + deploy ahead of the operator providing the key. Token registration
// (lib + route + schema) works regardless.
//
// Uses the FCM **HTTP v1** API (the legacy `Authorization: key=` endpoint was
// retired by Google in 2024). Auth is a short-lived OAuth2 access token minted
// from the service account via a self-signed JWT — no extra npm deps, just
// node:crypto + fetch. The token storage + dispatch fan-out are unchanged.

import { createSign } from "node:crypto";
import { inArray, ne, and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface PushPayload {
  title: string;
  body: string;
  // Arbitrary string map delivered to the app for tap-routing (e.g.
  // { type: "comment", assetId } → mobile opens that asset's detail).
  data?: Record<string, string>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    return sa as ServiceAccount;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fcm.bad_service_account_json"
    );
    return null;
  }
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Cache the access token across sends; Google issues them with a 3600s TTL.
let cachedToken: { value: string; expEpochMs: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  if (cachedToken && cachedToken.expEpochMs - 60_000 > Date.now()) {
    return cachedToken.value;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    createSign("RSA-SHA256").update(signingInput).sign(sa.private_key)
  );
  const assertion = `${signingInput}.${signature}`;

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "fcm.token_exchange_failed");
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    cachedToken = {
      value: json.access_token,
      expEpochMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "fcm.token_exchange_error"
    );
    return null;
  }
}

type SendResult = "sent" | "unregistered" | "error" | "skipped";

// Send to a single token via FCM v1. Returns "unregistered" when FCM reports
// the token is dead so the caller can prune it.
async function sendFcm(
  sa: ServiceAccount,
  accessToken: string,
  token: string,
  payload: PushPayload
): Promise<SendResult> {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: payload.data ?? {},
          },
        }),
      }
    );
    if (res.ok) return "sent";
    // 404 / UNREGISTERED → token is dead; prune it. Other codes are transient.
    const json = (await res.json().catch(() => null)) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    } | null;
    const status = json?.error?.status;
    const errorCode = json?.error?.details?.find((d) => d.errorCode)?.errorCode;
    if (res.status === 404 || status === "NOT_FOUND" || errorCode === "UNREGISTERED") {
      return "unregistered";
    }
    logger.warn({ status: res.status, fcmStatus: status }, "fcm.send_http_error");
    return "error";
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

    const sa = serviceAccount();
    if (!sa) {
      logger.info(
        { recipients: ids.length, tokens: rows.length, kind: payload.data?.type },
        "fcm.skipped_no_service_account"
      );
      return;
    }
    const accessToken = await getAccessToken(sa);
    if (!accessToken) {
      logger.warn({ recipients: ids.length }, "fcm.skipped_no_access_token");
      return;
    }

    const dead: string[] = [];
    await Promise.all(
      rows.map(async (r) => {
        const result = await sendFcm(sa, accessToken, r.token, payload);
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
