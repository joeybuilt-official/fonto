// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, isNull, gt, desc } from "drizzle-orm";

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

  const links = await db
    .select()
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.assetId, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        isNull(schema.shareLinks.revokedAt),
        gt(schema.shareLinks.expiresAt, new Date())
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

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

  const [link] = await db
    .insert(schema.shareLinks)
    .values({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      token,
      createdBy: user.id,
      expiresAt,
    })
    .returning();

  return NextResponse.json({
    token: link.token,
    url: `/share/${link.token}`,
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
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.shareLinks.assetId, id),
        inArray(schema.shareLinks.workspaceId, workspaceIds),
        isNull(schema.shareLinks.revokedAt)
      )
    );

  return NextResponse.json({ revoked: true });
}
