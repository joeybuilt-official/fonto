// SPDX-License-Identifier: AGPL-3.0-only
//
// Legacy per-asset share endpoint. Phase 2.5 kept this in place for one
// release alongside the new /api/v1/shares API. New rows are written through
// the same `share_links` schema with `targetType='asset'`, no password, and
// `allowDownload=true` so existing clients continue to "just work".
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, gt, desc, or, isNull } from "drizzle-orm";
import { generateUniqueSlug } from "@/lib/share-links/slug";

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 30;

/**
 * GET — list active (non-expired, non-revoked) share links for an asset.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ links: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  const now = new Date();
  const links = await db
    .select()
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.targetType, "asset"),
        eq(schema.shareLinks.targetId, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        eq(schema.shareLinks.revoked, false),
        or(isNull(schema.shareLinks.expiresAt), gt(schema.shareLinks.expiresAt, now))
      )
    )
    .orderBy(desc(schema.shareLinks.createdAt));

  return NextResponse.json({ links });
}

/**
 * POST — create a new share link. Body: { ttlHours?: number }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select({ id: schema.assets.id, workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let ttlHours = DEFAULT_TTL_HOURS;
  try {
    const body = (await request.json().catch(() => ({}))) as { ttlHours?: number };
    if (body.ttlHours && Number.isFinite(body.ttlHours)) {
      ttlHours = Math.min(Math.max(1, Math.floor(body.ttlHours)), MAX_TTL_HOURS);
    }
  } catch {
    /* no body */
  }

  const slug = await generateUniqueSlug();
  const token = `${slug}.${randomBytes(16).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

  const [link] = await db
    .insert(schema.shareLinks)
    .values({
      assetId: asset.id,
      targetType: "asset",
      targetId: asset.id,
      workspaceId: asset.workspaceId,
      token,
      slug,
      createdBy: user.id,
      expiresAt,
    })
    .returning();

  // TODO: bump assets.seq via nextSeq() once 2.3 lands.
  // TODO: emit "share.created" webhook event once 2.4 lands.

  return NextResponse.json({
    token: link.token,
    slug: link.slug,
    url: `/share/${link.slug}`,
    expiresAt: link.expiresAt,
  });
}

/**
 * DELETE — revoke all active share links for an asset.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  await db
    .update(schema.shareLinks)
    .set({ revoked: true, revokedAt: new Date() })
    .where(
      and(
        eq(schema.shareLinks.targetType, "asset"),
        eq(schema.shareLinks.targetId, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        eq(schema.shareLinks.revoked, false)
      )
    );

  // TODO: bump assets.seq via nextSeq() once 2.3 lands.
  // TODO: emit "share.revoked" webhook event once 2.4 lands.

  return NextResponse.json({ revoked: true });
}
