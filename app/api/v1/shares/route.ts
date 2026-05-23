// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Share-link management API (Phase 2.5).
//
//   POST   /api/v1/shares  — create a new share for an asset/collection/set
//   GET    /api/v1/shares  — list active shares in the caller's workspaces
//
// Per-share revocation lives at /api/v1/shares/:id (DELETE).
//
// The legacy /api/v1/assets/:id/share endpoint stays in place for one
// release; it now writes through the same schema (default targetType='asset',
// no password, allowDownload=true, 24h TTL).

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, desc, eq, inArray, isNull, or, gt } from "drizzle-orm";
import { hashPassword } from "@/lib/share-links/password";
import { generateUniqueSlug } from "@/lib/share-links/slug";
import { recordAuditEvent, AuditAction } from "@/lib/audit";

type TargetType = "asset" | "collection" | "set";

const ALLOWED_TARGET_TYPES = new Set<TargetType>(["asset", "collection", "set"]);

const ABSOLUTE_MAX_EXPIRY_MS = 1000 * 60 * 60 * 24 * 365; // 1 year cap

interface CreateBody {
  targetType?: string;
  targetId?: string;
  password?: string;
  allowDownload?: boolean;
  maxViews?: number;
  expiresAt?: string | null;
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { targetType, targetId } = body;
  if (!targetType || !ALLOWED_TARGET_TYPES.has(targetType as TargetType)) {
    return NextResponse.json({ error: "Invalid targetType" }, { status: 400 });
  }
  if (!targetId || typeof targetId !== "string") {
    return NextResponse.json({ error: "Invalid targetId" }, { status: 400 });
  }

  // Authorize the target — caller must own a workspace that contains it.
  let resolvedWorkspaceId: string | null = null;
  if (targetType === "asset") {
    const [row] = await db
      .select({ workspaceId: schema.assets.workspaceId })
      .from(schema.assets)
      .where(and(eq(schema.assets.id, targetId), inArray(schema.assets.workspaceId, workspaceIds)))
      .limit(1);
    resolvedWorkspaceId = row?.workspaceId ?? null;
  } else if (targetType === "collection") {
    const [row] = await db
      .select({ workspaceId: schema.collections.workspaceId })
      .from(schema.collections)
      .where(
        and(eq(schema.collections.id, targetId), inArray(schema.collections.workspaceId, workspaceIds))
      )
      .limit(1);
    resolvedWorkspaceId = row?.workspaceId ?? null;
  } else if (targetType === "set") {
    // "set" maps to smart_collections in our current schema.
    const [row] = await db
      .select({ workspaceId: schema.smartCollections.workspaceId })
      .from(schema.smartCollections)
      .where(
        and(
          eq(schema.smartCollections.id, targetId),
          inArray(schema.smartCollections.workspaceId, workspaceIds)
        )
      )
      .limit(1);
    resolvedWorkspaceId = row?.workspaceId ?? null;
  }
  if (!resolvedWorkspaceId) {
    return NextResponse.json({ error: "Target not found" }, { status: 404 });
  }

  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const t = Date.parse(body.expiresAt);
    if (!Number.isFinite(t)) {
      return NextResponse.json({ error: "Invalid expiresAt" }, { status: 400 });
    }
    if (t < Date.now()) {
      return NextResponse.json({ error: "expiresAt must be in the future" }, { status: 400 });
    }
    if (t - Date.now() > ABSOLUTE_MAX_EXPIRY_MS) {
      return NextResponse.json({ error: "expiresAt too far in the future" }, { status: 400 });
    }
    expiresAt = new Date(t);
  }

  let maxViews: number | null = null;
  if (body.maxViews !== undefined && body.maxViews !== null) {
    if (!Number.isFinite(body.maxViews) || body.maxViews < 1) {
      return NextResponse.json({ error: "Invalid maxViews" }, { status: 400 });
    }
    maxViews = Math.floor(body.maxViews);
  }

  const allowDownload = body.allowDownload !== false; // default true

  let passwordHash: string | null = null;
  if (body.password) {
    if (typeof body.password !== "string" || body.password.length < 4) {
      return NextResponse.json(
        { error: "Password must be at least 4 characters" },
        { status: 400 }
      );
    }
    passwordHash = await hashPassword(body.password);
  }

  const slug = await generateUniqueSlug();
  // Mirror slug into the legacy `token` column for the duration of the
  // backward-compat window. New public URLs use /share/{slug}; the old
  // /share/{token} route resolves via slug too (since slug === token now).
  const token = `${slug}.${randomBytes(16).toString("base64url")}`;

  const [link] = await db
    .insert(schema.shareLinks)
    .values({
      assetId: targetId, // legacy mirror; TODO(2.6) drop
      workspaceId: resolvedWorkspaceId,
      targetType,
      targetId,
      token,
      slug,
      passwordHash,
      allowDownload,
      maxViews,
      createdBy: user.id,
      expiresAt,
    })
    .returning();

  // TODO: bump assets.seq via nextSeq() once 2.3 lands so clients learn about
  // new shares. TODO: emit "share.created" webhook event once 2.4 lands.

  void recordAuditEvent({
    workspaceId: resolvedWorkspaceId,
    userId: user.id,
    action: AuditAction.ShareCreate,
    targetType: "share_link",
    targetId: link.id,
    metadata: {
      targetType,
      targetId,
      slug: link.slug,
      passwordProtected: link.passwordHash !== null,
      allowDownload: link.allowDownload,
      maxViews: link.maxViews,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    },
    request,
  });

  const origin = request.headers.get("origin") ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  return NextResponse.json({
    id: link.id,
    slug: link.slug,
    url: `${origin}/share/${link.slug}`,
    targetType: link.targetType,
    targetId: link.targetId,
    allowDownload: link.allowDownload,
    maxViews: link.maxViews,
    viewCount: link.viewCount,
    expiresAt: link.expiresAt,
    passwordProtected: link.passwordHash !== null,
    createdAt: link.createdAt,
  });
}

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ shares: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const now = new Date();
  const rows = await db
    .select({
      id: schema.shareLinks.id,
      slug: schema.shareLinks.slug,
      targetType: schema.shareLinks.targetType,
      targetId: schema.shareLinks.targetId,
      workspaceId: schema.shareLinks.workspaceId,
      allowDownload: schema.shareLinks.allowDownload,
      maxViews: schema.shareLinks.maxViews,
      viewCount: schema.shareLinks.viewCount,
      expiresAt: schema.shareLinks.expiresAt,
      lastAccessedAt: schema.shareLinks.lastAccessedAt,
      createdAt: schema.shareLinks.createdAt,
      passwordHash: schema.shareLinks.passwordHash,
      revoked: schema.shareLinks.revoked,
    })
    .from(schema.shareLinks)
    .where(
      and(
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        eq(schema.shareLinks.revoked, false),
        or(isNull(schema.shareLinks.expiresAt), gt(schema.shareLinks.expiresAt, now))
      )
    )
    .orderBy(desc(schema.shareLinks.createdAt));

  return NextResponse.json({
    shares: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      targetType: r.targetType,
      targetId: r.targetId,
      workspaceId: r.workspaceId,
      allowDownload: r.allowDownload,
      maxViews: r.maxViews,
      viewCount: r.viewCount,
      expiresAt: r.expiresAt,
      lastAccessedAt: r.lastAccessedAt,
      createdAt: r.createdAt,
      passwordProtected: r.passwordHash !== null,
      revoked: r.revoked,
    })),
  });
}
