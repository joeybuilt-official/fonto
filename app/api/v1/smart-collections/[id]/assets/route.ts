// SPDX-License-Identifier: AGPL-3.0-only
// Executes a smart collection's saved query against the assets table.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, inArray, ilike, gte, lte, SQL, isNull } from "drizzle-orm";

type Condition = {
  field: string;
  op: "eq" | "neq" | "contains" | "startsWith" | "gte" | "lte";
  value: string;
};

type SmartQuery = {
  conditions?: Condition[];
  logic?: "and" | "or";
  // Phase 3.4 — top-level facet DSL extensions. These are AND-ed with the
  // user's conditions (and with each other), regardless of `logic`. They
  // exist as dedicated keys rather than `Condition` entries so the UI can
  // surface them as named filter chips and clients don't have to know the
  // `{ field, op, value }` shape for the common cases.
  favorite?: boolean;
  ratingMin?: number;
};

function buildCondition(c: Condition): SQL | null {
  const { field, op, value } = c;
  if (!value) return null;

  switch (field) {
    case "classification":
      return op === "eq"
        ? eq(schema.assets.classification, value)
        : op === "contains"
        ? ilike(schema.assets.classification, `%${value}%`)
        : null;
    case "mimeType":
      return op === "startsWith"
        ? ilike(schema.assets.mimeType, `${value}%`)
        : op === "eq"
        ? eq(schema.assets.mimeType, value)
        : null;
    case "source":
      return eq(schema.assets.source, value);
    case "capturedAt":
      if (op === "gte") return gte(schema.assets.capturedAt, new Date(value));
      if (op === "lte") return lte(schema.assets.capturedAt, new Date(value));
      return null;
    case "createdAt":
      if (op === "gte") return gte(schema.assets.createdAt, new Date(value));
      if (op === "lte") return lte(schema.assets.createdAt, new Date(value));
      return null;
    case "description":
      return ilike(schema.assets.description, `%${value}%`);
    case "extractedText":
      return ilike(schema.assets.extractedText, `%${value}%`);
    default:
      return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [sc] = await db
    .select()
    .from(schema.smartCollections)
    .where(and(eq(schema.smartCollections.id, id), inArray(schema.smartCollections.workspaceId, workspaceIds)))
    .limit(1);
  if (!sc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const q = sc.query as SmartQuery;
  const conditions: SQL[] = [
    inArray(schema.assets.workspaceId, workspaceIds),
    isNull(schema.assets.deletedAt),
  ];

  const userConditions = (q.conditions ?? [])
    .map(buildCondition)
    .filter((c): c is SQL => c !== null);

  if (userConditions.length > 0) {
    if (q.logic === "or") {
      conditions.push(or(...userConditions)!);
    } else {
      conditions.push(...userConditions);
    }
  }

  // Phase 3.4 — facet predicates always AND with everything else (including
  // `logic: "or"` groups). Both are validated: favorite must be strictly
  // `true` to apply (false/undefined are "no opinion"); ratingMin must be
  // an integer in 1..5.
  if (q.favorite === true) {
    conditions.push(eq(schema.assets.isFavorite, true));
  }
  if (
    typeof q.ratingMin === "number" &&
    Number.isInteger(q.ratingMin) &&
    q.ratingMin >= 1 &&
    q.ratingMin <= 5
  ) {
    conditions.push(gte(schema.assets.rating, q.ratingMin));
  }

  const assets = await db
    .select()
    .from(schema.assets)
    .where(and(...conditions))
    .orderBy(schema.assets.createdAt)
    .limit(200);

  return NextResponse.json({ assets, total: assets.length, query: q });
}
