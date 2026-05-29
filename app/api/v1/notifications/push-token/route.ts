// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.4 — per-device FCM push token registration.
//
//   POST /api/v1/notifications/push-token
//     Body: { deviceId, token, platform: 'android'|'ios'|'web' }
//     Upsert the caller's token for that device. Re-registering the same
//     device replaces its token + bumps updated_at.
//   DELETE /api/v1/notifications/push-token
//     Body: { deviceId }
//     Deregister this device (called on sign-out). Idempotent.
//
// Authz: any authenticated user manages their own tokens. Tokens are keyed
// to the caller's user id, so there's no cross-user surface.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { db, schema } from "@/lib/db";
import { and, eq } from "drizzle-orm";

const VALID_PLATFORMS = ["android", "ios", "web"] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

function parsePlatform(value: unknown): Platform | null {
  return typeof value === "string" && (VALID_PLATFORMS as readonly string[]).includes(value)
    ? (value as Platform)
    : null;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    deviceId?: unknown;
    token?: unknown;
    platform?: unknown;
  } | null;
  if (!body || typeof body.deviceId !== "string" || typeof body.token !== "string") {
    return NextResponse.json({ error: "deviceId + token required" }, { status: 400 });
  }
  const platform = parsePlatform(body.platform);
  if (!platform) {
    return NextResponse.json(
      { error: "platform must be 'android', 'ios', or 'web'" },
      { status: 400 }
    );
  }

  await db
    .insert(schema.pushTokens)
    .values({
      userId: user.id,
      deviceId: body.deviceId,
      token: body.token,
      platform,
    })
    .onConflictDoUpdate({
      target: [schema.pushTokens.userId, schema.pushTokens.deviceId],
      set: { token: body.token, platform, updatedAt: new Date() },
    });

  return new NextResponse(null, { status: 204 });
}

export async function DELETE(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    deviceId?: unknown;
  } | null;
  if (!body || typeof body.deviceId !== "string") {
    return NextResponse.json({ error: "deviceId required" }, { status: 400 });
  }

  await db
    .delete(schema.pushTokens)
    .where(
      and(
        eq(schema.pushTokens.userId, user.id),
        eq(schema.pushTokens.deviceId, body.deviceId)
      )
    );

  return new NextResponse(null, { status: 204 });
}
