// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — every workspace on the instance with owner + quota + usage.
// Instance-admin only; intentionally NOT membership-scoped.
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireInstanceAdmin } from "@/lib/authz/instance";
import { loadUsersByIds, userEmail } from "@/lib/auth/lookupUsers";

export async function GET() {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) return gate.response;

  const rows = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
      ownerId: schema.workspaces.userId,
      quotaBytes: schema.workspaces.quotaBytes,
      usageBytes: schema.workspaces.usageBytes,
      createdAt: schema.workspaces.createdAt,
    })
    .from(schema.workspaces)
    .orderBy(desc(schema.workspaces.createdAt));

  const owners = await loadUsersByIds(rows.map((r) => r.ownerId));

  return NextResponse.json({
    workspaces: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      ownerId: r.ownerId,
      ownerEmail: userEmail(owners.get(r.ownerId)),
      quotaBytes: r.quotaBytes,
      usageBytes: r.usageBytes,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
