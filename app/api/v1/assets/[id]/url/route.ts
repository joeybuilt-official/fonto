// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { getS3Client, assetStorageKey } from "@/lib/r2";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Phase 1.1 — variant query param. `original` keeps the legacy behavior;
// `thumb` / `preview` resolve the derivative R2 keys if present (and fall
// back to the original when NULL, so legacy assets keep rendering until the
// backfill catches them).
type Variant = "thumb" | "preview" | "original";

function parseVariant(raw: string | null): Variant {
  if (raw === "thumb" || raw === "preview" || raw === "original") return raw;
  return "original";
}

export async function GET(
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
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bucket = process.env.R2_BUCKET!;
  const variant = parseVariant(request.nextUrl.searchParams.get("variant"));

  // Pick the R2 key based on the requested variant. Derivatives may be NULL
  // for legacy / non-image / unbackfilled rows — fall through to the
  // original key in that case so the client never sees a 404 because of an
  // in-flight backfill.
  let key: string;
  let servedVariant: Variant = variant;
  if (variant === "thumb" && asset.thumbnailKey) {
    key = asset.thumbnailKey;
  } else if (variant === "preview" && asset.previewKey) {
    key = asset.previewKey;
  } else {
    key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
    servedVariant = "original";
  }

  const url = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 }
  );

  // Cache-Control on the JSON response itself: derivative URLs are stable
  // for the variant lifetime, so an hour of caching on the JSON wrapper is
  // safe. Originals stay no-store to preserve current behavior.
  const headers: Record<string, string> = {};
  if (servedVariant !== "original") {
    headers["Cache-Control"] = "public, max-age=3600";
  }

  return NextResponse.json(
    { url, expiresIn: 3600, variant: servedVariant },
    { headers }
  );
}
