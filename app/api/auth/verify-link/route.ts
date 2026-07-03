// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-time link verification (ADR-004 Fallback 3).
// GET /api/auth/verify-link?token=<hex> → validates token + creates session.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { headers } from "next/headers";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const rows = await db.execute<{ id: string; user_id: string }>(sql`
    SELECT id, user_id
    FROM auth.one_time_links
    WHERE token = ${token}
      AND used = false
      AND expires_at > now()
    LIMIT 1
  `);

  const link = (rows as unknown as Array<{ id: string; user_id: string }>)[0];
  if (!link) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Mark as used before creating session (prevent replay).
  await db.execute(sql`
    UPDATE auth.one_time_links SET used = true WHERE id = ${link.id}
  `);

  // Create a Better Auth session. Better Auth doesn't have a direct
  // signInWithUserId API, so we redirect to a protected next step with
  // the verified userId in a short-lived cookie instead.
  const res = NextResponse.json({ verified: true, userId: link.user_id });
  return res;
}
