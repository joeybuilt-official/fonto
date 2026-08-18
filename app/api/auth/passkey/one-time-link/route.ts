// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// One-time link generation (ADR-004 Fallback 3 — legacy account bridge).
// Authenticated user POSTs → generates a 32-byte random token stored in
// fonto.one_time_links (15min TTL), returns {link:"/auth/login?token=..."}.
// Hard rule: only issued from an authenticated session (ADR-004 §risk).

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { headers } from "next/headers";

export async function POST(_req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = randomBytes(32).toString("hex");
  const userId = session.user.id;

  await db.execute(sql`
    INSERT INTO fonto.one_time_links (user_id, token)
    VALUES (${userId}, ${token})
  `);

  const link = `/login?token=${token}`;
  return NextResponse.json({ link });
}
