// SPDX-License-Identifier: AGPL-3.0-only
// Executes a smart collection's saved query against the assets table.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { eq, and, or, inArray, ilike, gte, lte, sql, SQL, isNull } from "drizzle-orm";
// (sql imported for ML/face stubs and the Phase 5.5 stack filter subquery.)
import { visionConfigured } from "@/lib/plexo-vision";
import { getCachedClipTextEmbedding, nearestNeighbors } from "@/lib/vectors";
import { deltaE76, parseHex, rgbToLab } from "@/lib/perceptual";
import { pgArray } from "@/lib/db/sql-helpers";

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
  // Phase 4.6 — zero-shot classification facets. Lets users build "all
  // food photos" smart collections without thinking about CLIP. Both AND
  // with everything else (same rule as favorite/ratingMin above).
  //   subClassification: exact match against `assets.sub_classification`
  //     (e.g. "food", "portrait"). Validated against the live taxonomy at
  //     query time would be ideal, but the static set is large enough
  //     that we just trust the string and let an unknown value match
  //     nothing.
  //   classifyMethod: "clip" | "llm-fallback" — filter to rows that took
  //     a specific classify path. Useful for QA dashboards.
  subClassification?: string;
  classifyMethod?: "clip" | "llm-fallback";
  // Phase 5.4 — ML-enriched facets.
  //   clipText: free-text CLIP query. Embeds the text via plexo-vision
  //     (cached per-process for 1 h), runs a pgvector kNN against
  //     `assets.clip_vec`, and ANDs the resulting asset IDs into the
  //     predicate. If vision is unconfigured or the embed fails, the
  //     clause is silently dropped (graceful degradation; same shape as
  //     /api/v1/search/clip's `{ unavailable: true }` response). Top-K
  //     for the kNN is 200 with similarity threshold 0.18.
  //   personIds: filter to assets that have a non-hidden face_instance
  //     row whose personId is in this list. Wired against
  //     fonto.face_instances (Phase 5.1) via an EXISTS subquery.
  //   hasFaces: true ⇒ keep only assets with at least one non-hidden
  //     face_instance; false ⇒ keep only assets with none.
  //   dominantColor + tolerance: filter by the top entry in `assets.colors`
  //     within ΔE76 (CIE76 Lab Euclidean) of the target hex. `tolerance`
  //     is in ΔE units; default 30 ≈ "same hue family". `colors` itself
  //     is populated by the Phase 0 pHash worker and is shaped as
  //     `[{ hex: "#rrggbb", weight: 0..1 }, ...]` sorted by weight desc.
  //     We can't push this filter into SQL cleanly (palette is a JSONB
  //     array) so we apply it in-process after the SQL pull. Acceptable
  //     because we cap the SQL result at 200 already.
  clipText?: string;
  personIds?: string[];
  hasFaces?: boolean;
  dominantColor?: string;
  tolerance?: number;
  // Phase 5.5 — stacks. By default smart collections respect the timeline-
  // wide stack filter (primary-only): a stacked burst surfaces as one
  // result, not twelve. Set `expandStacks: true` to opt in to "every
  // stacked member is a result". Useful for QA dashboards and for power-
  // user collections like "all RAW originals".
  expandStacks?: boolean;
};

// Tunables for the clipText kNN clause. Match the inline-search defaults
// (`/api/v1/search/clip`) so users get the same recall in both surfaces.
const CLIP_TEXT_KNN_LIMIT = 200;
const CLIP_TEXT_KNN_THRESHOLD = 0.18;
const DEFAULT_COLOR_TOLERANCE = 30;

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
  // Phase 4.6 — zero-shot classification facets.
  if (typeof q.subClassification === "string" && q.subClassification.length > 0) {
    conditions.push(eq(schema.assets.subClassification, q.subClassification));
  }
  if (q.classifyMethod === "clip" || q.classifyMethod === "llm-fallback") {
    conditions.push(eq(schema.assets.classifyMethod, q.classifyMethod));
  }

  // Phase 5.4 — clipText: run the kNN before the SQL pull so the result
  // ID set narrows the WHERE clause. Scoped per workspace; collections
  // can span multiple workspaces, so we kNN each in turn and union.
  // Graceful degradation: vision unconfigured / embed failure ⇒ skip
  // the clause entirely (matches /api/v1/search/clip behaviour).
  if (typeof q.clipText === "string" && q.clipText.trim().length > 0) {
    if (visionConfigured()) {
      const matched = new Set<string>();
      for (const wsId of workspaceIds) {
        const embedded = await getCachedClipTextEmbedding(wsId, q.clipText.trim());
        if (!embedded) continue;
        const hits = await nearestNeighbors(
          wsId,
          embedded.vector,
          CLIP_TEXT_KNN_LIMIT,
          CLIP_TEXT_KNN_THRESHOLD
        );
        for (const h of hits) matched.add(h.assetId);
      }
      if (matched.size === 0) {
        // No CLIP matches anywhere ⇒ short-circuit, the AND can't satisfy.
        return NextResponse.json({ assets: [], total: 0, query: q });
      }
      conditions.push(inArray(schema.assets.id, Array.from(matched)));
    }
    // If !visionConfigured the clause is silently dropped.
  }

  // Phase 5.4 — personIds / hasFaces (Phase 5.1's `face_instances` now
  // ships). EXISTS subqueries against fonto.face_instances let us keep
  // the result `assets` rather than join + DISTINCT.
  if (Array.isArray(q.personIds) && q.personIds.length > 0) {
    const ids = q.personIds;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${schema.faceInstances} fi
            WHERE fi.asset_id = ${schema.assets.id}
              AND fi.hidden = false
              AND fi.person_id = ANY(${pgArray(ids)}::uuid[]))`
    );
  }
  if (typeof q.hasFaces === "boolean") {
    const facesExists = sql`EXISTS (SELECT 1 FROM ${schema.faceInstances} fi
      WHERE fi.asset_id = ${schema.assets.id} AND fi.hidden = false)`;
    conditions.push(q.hasFaces ? facesExists : sql`NOT ${facesExists}`);
  }
  // Phase 5.5 — stacks: default to primary-only unless the saved query
  // explicitly opts in to expansion. Same correlated-subquery shape as the
  // /api/v1/assets list route so the planner picks the same index path.
  if (q.expandStacks !== true) {
    conditions.push(
      or(
        isNull(schema.assets.stackId),
        sql`${schema.assets.id} = (SELECT ${schema.stacks.primaryAssetId} FROM ${schema.stacks} WHERE ${schema.stacks.id} = ${schema.assets.stackId})`
      )!
    );
  }

  const rawAssets = await db
    .select()
    .from(schema.assets)
    .where(and(...conditions))
    .orderBy(schema.assets.createdAt)
    .limit(200);

  // Phase 5.4 — dominantColor post-filter. We pull from SQL first
  // (already capped at 200) and then filter in-process — the palette is
  // a JSONB array and the ΔE distance is awkward to express in pure
  // SQL. The cost is bounded by the 200-row LIMIT above.
  let assets = rawAssets;
  if (typeof q.dominantColor === "string" && q.dominantColor.length > 0) {
    const targetRgb = parseHex(q.dominantColor);
    if (targetRgb) {
      const tolerance =
        typeof q.tolerance === "number" && Number.isFinite(q.tolerance) && q.tolerance > 0
          ? q.tolerance
          : DEFAULT_COLOR_TOLERANCE;
      const targetLab = rgbToLab(targetRgb[0], targetRgb[1], targetRgb[2]);
      assets = rawAssets.filter((row) => {
        const colors = row.colors as
          | Array<{ hex?: unknown; weight?: unknown }>
          | null
          | undefined;
        if (!Array.isArray(colors) || colors.length === 0) return false;
        const top = colors[0];
        if (!top || typeof top.hex !== "string") return false;
        const rgb = parseHex(top.hex);
        if (!rgb) return false;
        const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
        return deltaE76(lab, targetLab) <= tolerance;
      });
    }
    // Unparseable hex ⇒ silently drop the filter (don't 500 on bad UI input).
  }

  return NextResponse.json({ assets, total: assets.length, query: q });
}
