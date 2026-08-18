// SPDX-License-Identifier: MIT
// "More like this" — visual similarity via the asset's own CLIP embedding
// (pgvector kNN over fonto.assets.clip_vec). Falls back to same-classification
// when the asset has no embedding yet. The previous implementation ran a Plexo
// TEXT memory search over description+OCR+filename, which gave shallow results
// for text-less photos and ignored the CLIP vectors already stored.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, ne, isNull } from "drizzle-orm";
import { nearestNeighbors } from "@/lib/vectors";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { parseScopeParam, scopeCond } from "@/lib/scope";

const LIMIT = 10;
// Loosely-related visual neighbours. Image-to-image similarity sits higher than
// text-to-image, but staying permissive keeps the panel populated.
const SIMILARITY_THRESHOLD = 0.2;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ assets: [] });
  const workspaceIds = workspaces.map((w) => w.id);

  // ADR 0008 — scope default
  const scope = parseScopeParam(new URL(_req.url).searchParams);
  const __sc = scopeCond(scope);

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds), isNull(schema.assets.deletedAt)))
    .limit(1);
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Primary path: CLIP image kNN against the asset's own embedding. Pure
  // pgvector — no vision sidecar needed, since clip_vec is already persisted.
  if (asset.clipVec) {
    // Fetch one extra; the source asset itself scores 1.0 and must be dropped.
    const hits = await nearestNeighbors(
      asset.workspaceId,
      asset.clipVec,
      LIMIT + 1,
      SIMILARITY_THRESHOLD,
      scope
    );
    const ids = hits.map((h) => h.assetId).filter((hid) => hid !== id);
    if (ids.length) {
      const rows = await db
        .select()
        .from(schema.assets)
        .where(
          and(
            inArray(schema.assets.id, ids),
            eq(schema.assets.workspaceId, asset.workspaceId),
            isNull(schema.assets.deletedAt),
            __sc
          )
        );
      // Preserve kNN ordering (best match first); drop rows filtered out above.
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids
        .map((hid) => byId.get(hid))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .slice(0, LIMIT)
        .map((r) => serializeAsset(r));
      return NextResponse.json({ assets: ordered, source: "clip" });
    }
    // No neighbours above threshold — fall through to classification.
  }

  // Fallback: same classification (asset never embedded, or no CLIP neighbours).
  const similar = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.workspaceId, workspaceIds),
        ne(schema.assets.id, id),
        isNull(schema.assets.deletedAt),
        eq(schema.assets.classification, asset.classification ?? ""),
        __sc
      )
    )
    .limit(LIMIT);
  return NextResponse.json({
    assets: similar.map((r) => serializeAsset(r)),
    source: "classification",
  });
}
