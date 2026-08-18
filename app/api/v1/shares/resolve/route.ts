// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6.5 — Public share-token resolution for mobile App Links handler.
//
// GET /api/v1/shares/resolve?slug=<slug_or_token>
//
// Returns { targetType, targetId } for a valid, non-password-protected,
// non-expired, non-revoked share link so the mobile app can navigate
// directly to the asset detail screen without opening a browser. Password-
// protected shares return 403; the mobile caller falls back to url_launcher.
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  const now = new Date();
  const [link] = await db
    .select({
      targetType: schema.shareLinks.targetType,
      targetId: schema.shareLinks.targetId,
      passwordHash: schema.shareLinks.passwordHash,
      maxViews: schema.shareLinks.maxViews,
      viewCount: schema.shareLinks.viewCount,
    })
    .from(schema.shareLinks)
    .where(
      and(
        or(eq(schema.shareLinks.slug, slug), eq(schema.shareLinks.token, slug)),
        eq(schema.shareLinks.revoked, false),
        or(isNull(schema.shareLinks.expiresAt), gt(schema.shareLinks.expiresAt, now)),
      ),
    )
    .limit(1);

  if (!link) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (link.passwordHash) {
    return NextResponse.json({ error: "password required" }, { status: 403 });
  }
  if (link.maxViews !== null && link.viewCount >= link.maxViews) {
    return NextResponse.json({ error: "view limit reached" }, { status: 410 });
  }

  return NextResponse.json({
    targetType: link.targetType,
    targetId: link.targetId,
  });
}
