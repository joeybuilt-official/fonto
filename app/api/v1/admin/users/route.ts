// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance user list with per-user workspace count + usage.
// Instance-admin only. Reads the Better Auth `user` model through the adapter
// (separate schema) and joins workspace aggregates from fonto.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireInstanceAdmin } from "@/lib/authz/instance";

interface AuthUserRow {
  id: string;
  email?: string | null;
  name?: string | null;
  createdAt?: Date | string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);

  let users: AuthUserRow[] = [];
  try {
    const ctx = await auth.$context;
    users = await ctx.adapter.findMany<AuthUserRow>({
      model: "user",
      limit,
      offset,
      sortBy: { field: "createdAt", direction: "desc" },
    });
  } catch {
    users = [];
  }

  // Per-owner workspace count + summed usage from fonto (one grouped query).
  const agg = (await db.execute(sql`
    SELECT user_id, count(*)::int AS ws_count, COALESCE(SUM(usage_bytes), 0)::bigint AS usage
    FROM fonto.workspaces
    GROUP BY user_id
  `)) as unknown as Array<{ user_id: string; ws_count: number; usage: number | string }>;
  const byUser = new Map(agg.map((r) => [r.user_id, r]));

  return NextResponse.json({
    users: users.map((u) => {
      const a = byUser.get(u.id);
      return {
        id: u.id,
        email: u.email ?? null,
        name: u.name ?? null,
        createdAt:
          u.createdAt instanceof Date
            ? u.createdAt.toISOString()
            : (u.createdAt ?? null),
        workspaceCount: a?.ws_count ?? 0,
        usageBytes: a ? Number(a.usage) : 0,
      };
    }),
    limit,
    offset,
  });
}
