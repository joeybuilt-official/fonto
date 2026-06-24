// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-wide totals for the admin console. Instance-admin
// only. Numbers are NOT membership-scoped (that's the whole point of the tier).
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireInstanceAdmin } from "@/lib/authz/instance";

export async function GET() {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;

  const [agg] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM fonto.workspaces) AS workspace_count,
      (SELECT count(*) FROM fonto.assets WHERE lifecycle_state = 'active') AS active_assets,
      (SELECT count(*) FROM fonto.assets) AS total_assets,
      (SELECT COALESCE(SUM(usage_bytes), 0) FROM fonto.workspaces) AS usage_bytes
  `)) as unknown as Array<{
    workspace_count: number | string;
    active_assets: number | string;
    total_assets: number | string;
    usage_bytes: number | string;
  }>;

  let userCount: number | null = null;
  try {
    const ctx = await auth.$context;
    // Better Auth adapter exposes count(); fall back to null if unavailable.
    const c = (ctx.adapter as unknown as {
      count?: (a: { model: string }) => Promise<number>;
    }).count;
    if (c) userCount = await c.call(ctx.adapter, { model: "user" });
  } catch {
    userCount = null;
  }

  return NextResponse.json({
    workspaceCount: Number(agg?.workspace_count ?? 0),
    activeAssets: Number(agg?.active_assets ?? 0),
    totalAssets: Number(agg?.total_assets ?? 0),
    usageBytes: Number(agg?.usage_bytes ?? 0),
    userCount,
  });
}
