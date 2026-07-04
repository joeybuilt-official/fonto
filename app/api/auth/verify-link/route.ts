// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// One-time link verification (ADR-004 Fallback 3).
// GET /api/auth/verify-link?token=<hex> → validates token + creates session.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mintSession } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  // Atomically claim the token: the UPDATE both validates (unused, unexpired)
  // and consumes it in one statement, so two concurrent requests cannot both
  // redeem the same link (single-use, race-free — ADR-004 Fallback 3).
  const rows = await db.execute<{ user_id: string }>(sql`
    UPDATE auth.one_time_links
    SET used = true
    WHERE token = ${token}
      AND used = false
      AND expires_at > now()
    RETURNING user_id
  `);

  const claimed = (rows as unknown as Array<{ user_id: string }>)[0];
  if (!claimed) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Mint a real Better Auth session for the verified legacy user.
  await mintSession(claimed.user_id);
  return NextResponse.json({ verified: true, userId: claimed.user_id });
}
