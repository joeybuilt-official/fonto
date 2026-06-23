// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Review-at-scale (M15.1 / ADR 0012) — reason-bucketing for the date review
// queue + a server-resolved, resumable bulk apply over a bucket.
//
// A bucket = (conflict_flag × dominant_evidence_source) over the gate's REVIEW
// band. Users clear tens of thousands of items by deciding once per bucket
// ("trust the filename for all 1,204 of these") instead of one-by-one. The
// dominant evidence source is the denormalised generated column added in
// migration 0050, so grouping is a cheap indexed GROUP BY — no JSONB scan.
//
// Provenance note: PROPOSE-DON'T-OVERWRITE (ADR-0005) holds — only an
// operator-initiated bucket action writes captured_at; the fuse worker never
// does. All actions are reversible (status transitions; the inference row keeps
// mapEstimate so a confirm can be reverted to inferred). PURGE is NOT here.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";
import { logger } from "@/lib/logger";

const HIGH = DEFAULT_GATE_THRESHOLDS.date.high; // 0.7
const LOW = DEFAULT_GATE_THRESHOLDS.date.low; // 0.35
const SAMPLE_PER_BUCKET = 12;

export type BucketAction = "confirm" | "reject" | "quarantine";

const ACTION_STATUS: Record<BucketAction, string> = {
  confirm: "confirmed",
  reject: "overridden",
  quarantine: "quarantined",
};

export type ConfidenceTier = "high" | "medium" | "low";

// Provisional, jargon-free labels (M15.2 design finalises the exact copy).
// Keyed by the engine's EvidenceType (lib/evidence/types.ts).
const SOURCE_LABEL: Record<string, string> = {
  exif: "From the photo's own info",
  filename: "From the file name",
  ocr_date: "From a date in the photo",
  fs_mtime: "From the file's saved date",
  identity_bound: "From who's in the photo",
  apparent_age: "From people's ages",
  trip_match: "From a matching trip",
  scene_season: "From the season",
  cluster_propagation: "From similar photos",
  co_occurrence: "From nearby photos",
};

function sourceLabel(source: string | null): string {
  return (source && SOURCE_LABEL[source]) || "Other evidence";
}

function reasonLabel(source: string | null, conflict: boolean): string {
  const base = sourceLabel(source);
  return conflict ? `${base} — disagrees with the saved date` : base;
}

function tierOf(avgConfidence: number): ConfidenceTier {
  if (avgConfidence >= HIGH) return "high";
  if (avgConfidence >= (LOW + HIGH) / 2) return "medium";
  return "low";
}

function bucketId(source: string | null, conflict: boolean): string {
  return `${conflict ? "conflict" : "clean"}:${source ?? "unknown"}`;
}

// The gate's REVIEW band, in SQL: a conflict with conf >= LOW, OR a
// non-conflict in [LOW, HIGH). Mirrors review-queue/route.ts + dateBackfill.ts.
function reviewBandSql() {
  const conf = schema.imageDateInference.confidence;
  const conflict = schema.imageDateInference.conflictFlag;
  return sql`((${conflict} and ${conf} >= ${LOW}) or (not ${conflict} and ${conf} >= ${LOW} and ${conf} < ${HIGH}))`;
}

function baseWhere(workspaceId: string) {
  return and(
    eq(schema.assets.workspaceId, workspaceId),
    eq(schema.assets.lifecycleState, "active"),
    eq(schema.imageDateInference.status, "inferred")
  );
}

export interface DateBucketSample {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  mapEstimate: string | null;
  mapPrecision: string | null;
  confidence: number;
}

export interface DateBucket {
  bucketId: string;
  evidenceSource: string | null;
  conflict: boolean;
  reasonLabel: string;
  count: number;
  confidenceTier: ConfidenceTier;
  sample: DateBucketSample[];
}

/**
 * Reason-bucketed view of the date review queue for one workspace. One grouped
 * count query (bounded to ~evidence-types × {conflict,clean} buckets) plus one
 * bounded sample SELECT per non-empty bucket. Never returns the full queue.
 */
export async function listDateBuckets(workspaceId: string): Promise<{
  buckets: DateBucket[];
  totalReview: number;
}> {
  const conf = schema.imageDateInference.confidence;
  const conflictCol = schema.imageDateInference.conflictFlag;
  const sourceCol = schema.imageDateInference.dominantEvidenceSource;

  const grouped = await db
    .select({
      conflict: conflictCol,
      source: sourceCol,
      count: sql<number>`count(*)::int`,
      avgConf: sql<number>`avg(${conf})::float8`,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(and(baseWhere(workspaceId), reviewBandSql()))
    .groupBy(conflictCol, sourceCol);

  // Biggest buckets first — that's where the leverage is.
  grouped.sort((a, b) => b.count - a.count);

  const buckets: DateBucket[] = [];
  let totalReview = 0;
  for (const g of grouped) {
    totalReview += g.count;
    const sourcePred = g.source === null ? isNull(sourceCol) : eq(sourceCol, g.source);
    const sampleRows = await db
      .select({
        assetId: schema.imageDateInference.assetId,
        mapEstimate: schema.imageDateInference.mapEstimate,
        mapPrecision: schema.imageDateInference.mapPrecision,
        confidence: conf,
        filename: schema.assets.filename,
        capturedAt: schema.assets.capturedAt,
      })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(and(baseWhere(workspaceId), reviewBandSql(), eq(conflictCol, g.conflict), sourcePred))
      .orderBy(asc(conf))
      .limit(SAMPLE_PER_BUCKET);

    buckets.push({
      bucketId: bucketId(g.source, g.conflict),
      evidenceSource: g.source,
      conflict: g.conflict,
      reasonLabel: reasonLabel(g.source, g.conflict),
      count: g.count,
      confidenceTier: tierOf(g.avgConf ?? 0),
      sample: sampleRows.map((r) => ({
        assetId: r.assetId,
        filename: r.filename,
        capturedAt: r.capturedAt ? new Date(r.capturedAt).toISOString() : null,
        mapEstimate: r.mapEstimate ? String(r.mapEstimate) : null,
        mapPrecision: r.mapPrecision,
        confidence: Number(r.confidence.toFixed(3)),
      })),
    });
  }

  return { buckets, totalReview };
}

export interface BucketApplyOpts {
  evidenceSource: string | null;
  conflict: boolean;
  action: BucketAction;
  batchSize?: number;
  /** Safety cap on rows actioned in one apply (0 = no cap). */
  maxRows?: number;
}

export interface BucketApplyResult {
  workspaceId: string;
  bucketId: string;
  action: BucketAction;
  applied: number;
}

/**
 * Apply a reversible action to EVERY review-band row matching a bucket, in
 * idempotent resumable batches. The predicate is RE-RESOLVED each batch (the
 * queue is a stream — rows keep arriving as inference drains), and is scoped to
 * status='inferred' so a re-run / crash-resume never double-writes.
 */
export async function applyBucketReconcile(
  workspaceId: string,
  opts: BucketApplyOpts
): Promise<BucketApplyResult> {
  const { evidenceSource, conflict, action } = opts;
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? 200));
  const maxRows = opts.maxRows ?? 0;
  const log = logger.child({ component: "reconcile.bucket", workspaceId, action });

  const conflictCol = schema.imageDateInference.conflictFlag;
  const sourceCol = schema.imageDateInference.dominantEvidenceSource;
  const sourcePred = evidenceSource === null ? isNull(sourceCol) : eq(sourceCol, evidenceSource);
  const matchWhere = and(
    baseWhere(workspaceId),
    reviewBandSql(),
    eq(conflictCol, conflict),
    sourcePred
  );

  let applied = 0;
  for (;;) {
    if (maxRows && applied >= maxRows) break;
    const take = maxRows ? Math.min(batchSize, maxRows - applied) : batchSize;
    const batch = await db
      .select({
        assetId: schema.imageDateInference.assetId,
        mapEstimate: schema.imageDateInference.mapEstimate,
      })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(matchWhere)
      .limit(take);
    if (batch.length === 0) break;

    await db.transaction(async (tx) => {
      for (const row of batch) {
        // Only act if WE flip the row (guards a racing apply / re-fuse).
        const upd = await tx
          .update(schema.imageDateInference)
          .set({ status: ACTION_STATUS[action] })
          .where(
            and(
              eq(schema.imageDateInference.assetId, row.assetId),
              eq(schema.imageDateInference.status, "inferred")
            )
          )
          .returning({ assetId: schema.imageDateInference.assetId });
        if (upd.length === 0) continue;
        if (action === "confirm" && row.mapEstimate) {
          await tx
            .update(schema.assets)
            .set({ capturedAt: new Date(row.mapEstimate) })
            .where(and(eq(schema.assets.id, row.assetId), eq(schema.assets.workspaceId, workspaceId)));
        }
        applied++;
      }
    });
    if (batch.length < take) break;
  }

  log.info({ applied, evidenceSource, conflict }, "bucket reconcile applied");
  return { workspaceId, bucketId: bucketId(evidenceSource, conflict), action, applied };
}
