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

// ── Axis-agnostic opaque bucketKey (ADR 0059) ──────────────────────────────
// A bucket is identified by a single server-issued token `bucketKey`. The
// client treats it as opaque and passes it back verbatim; the server holds the
// ONLY parser (predicateForKey), which validates a `^(src|dir|time):` prefix
// and returns a fully PARAMETERIZED drizzle WHERE — the base64url folder path
// is never string-interpolated into SQL.

export type BucketAxis = "source" | "folder" | "time";

// 72h session gap for time-cluster bucketing; top-N cap for folder/time axes.
const TIME_GAP_MS = 72 * 60 * 60 * 1000;
const MAX_AXIS_BUCKETS = 40;

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function unb64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** source axis key — 1:1 with the legacy bucketId pair {evidenceSource,conflict}. */
export function srcBucketKey(source: string | null, conflict: boolean): string {
  return `src:${conflict ? "c" : "n"}:${source ?? "null"}`;
}
/** folder axis key — empty payload = directory_path IS NULL ("no folder"). */
function dirBucketKey(path: string | null): string {
  return path === null ? "dir:" : `dir:${b64url(path)}`;
}
/** time axis key — `time:null` = captured_at IS NULL; else half-open [start,end) ms. */
function timeBucketKey(startMs: number | null, endMs?: number): string {
  return startMs === null ? "time:null" : `time:${startMs}-${endMs}`;
}

/**
 * Resolve a frozen bucketKey to a parameterized drizzle predicate (membership
 * only — the caller ANDs baseWhere + reviewBandSql). Throws on a malformed key.
 * Shared by the sample SELECT, applyBucketReconcile, and applyBucketUndo so the
 * predicate is re-resolved identically every batch.
 */
export function predicateForKey(bucketKey: string) {
  const conflictCol = schema.imageDateInference.conflictFlag;
  const sourceCol = schema.imageDateInference.dominantEvidenceSource;
  const dirCol = schema.assets.directoryPath;
  const capCol = schema.assets.capturedAt;

  if (bucketKey.startsWith("src:")) {
    const rest = bucketKey.slice(4); // "c:<source>" | "n:<source>"
    if (rest[1] !== ":" || (rest[0] !== "c" && rest[0] !== "n")) {
      throw new Error("invalid src bucketKey");
    }
    const conflict = rest[0] === "c";
    const src = rest.slice(2);
    const sourcePred = src === "null" ? isNull(sourceCol) : eq(sourceCol, src);
    return and(eq(conflictCol, conflict), sourcePred)!;
  }
  if (bucketKey.startsWith("dir:")) {
    const payload = bucketKey.slice(4);
    if (payload === "") return isNull(dirCol);
    return eq(dirCol, unb64url(payload));
  }
  if (bucketKey.startsWith("time:")) {
    const payload = bucketKey.slice(5);
    if (payload === "null") return isNull(capCol);
    const m = /^(\d+)-(\d+)$/.exec(payload);
    if (!m) throw new Error("invalid time bucketKey");
    const start = new Date(Number(m[1]));
    const end = new Date(Number(m[2]));
    return and(sql`${capCol} >= ${start}`, sql`${capCol} < ${end}`)!;
  }
  throw new Error("unknown bucketKey axis");
}

// Compact human label for a time-cluster span (server-formatted; clients render
// it verbatim for the folder/time axes).
function timeRangeLabel(startMs: number, endMs: number): string {
  const a = new Date(startMs);
  const b = new Date(endMs - 1);
  const mo = (d: Date) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    if (a.getUTCMonth() === b.getUTCMonth()) return `${mo(a)} ${a.getUTCFullYear()}`;
    return `${mo(a)} – ${mo(b)} ${a.getUTCFullYear()}`;
  }
  return `${mo(a)} ${a.getUTCFullYear()} – ${mo(b)} ${b.getUTCFullYear()}`;
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
  /** Opaque, server-issued bucket identity (ADR 0059). Pass back verbatim. */
  bucketKey: string;
  axis: BucketAxis;
  /** Source-axis metadata — drives the conflict-compare affordance only. */
  evidenceSource: string | null;
  conflict: boolean;
  reasonLabel: string;
  count: number;
  confidenceTier: ConfidenceTier;
  sample: DateBucketSample[];
}

// One bounded sample SELECT for a resolved bucket predicate (lowest-confidence
// first — that's what an operator most wants to eyeball before applying).
async function sampleForPredicate(
  workspaceId: string,
  pred: ReturnType<typeof predicateForKey>
): Promise<DateBucketSample[]> {
  const conf = schema.imageDateInference.confidence;
  const rows = await db
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
    .where(and(baseWhere(workspaceId), reviewBandSql(), pred))
    .orderBy(asc(conf))
    .limit(SAMPLE_PER_BUCKET);
  return rows.map((r) => ({
    assetId: r.assetId,
    filename: r.filename,
    capturedAt: r.capturedAt ? new Date(r.capturedAt).toISOString() : null,
    mapEstimate: r.mapEstimate ? String(r.mapEstimate) : null,
    mapPrecision: r.mapPrecision,
    confidence: Number(r.confidence.toFixed(3)),
  }));
}

/**
 * Reason-bucketed view of the date review queue for one workspace, along ONE
 * axis (ADR 0059):
 *  - source (default): byte-identical to the shipped path — group by
 *    (conflict × dominant evidence source).
 *  - folder: exact-path GROUP BY directory_path (no LIKE roll-up; null → a
 *    "Files with no folder" bucket). Top-N by count.
 *  - time: 72h-gap session clusters on captured_at (top-N by count; null → one
 *    "No date yet" bucket).
 * Each bucket carries an opaque `bucketKey` + `axis`; the apply key is the
 * bucketKey, re-resolved server-side. Never returns the full queue.
 */
export async function listDateBuckets(
  workspaceId: string,
  axis: BucketAxis = "source"
): Promise<{ buckets: DateBucket[]; totalReview: number }> {
  if (axis === "folder") return listFolderBuckets(workspaceId);
  if (axis === "time") return listTimeBuckets(workspaceId);

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
    const key = srcBucketKey(g.source, g.conflict);
    buckets.push({
      bucketKey: key,
      axis: "source",
      evidenceSource: g.source,
      conflict: g.conflict,
      reasonLabel: reasonLabel(g.source, g.conflict),
      count: g.count,
      confidenceTier: tierOf(g.avgConf ?? 0),
      sample: await sampleForPredicate(workspaceId, predicateForKey(key)),
    });
  }

  return { buckets, totalReview };
}

// Folder axis — exact-path GROUP BY directory_path (ADR 0059: no LIKE roll-up,
// which keeps counts honest + apply idempotent). Null path → "no folder".
async function listFolderBuckets(
  workspaceId: string
): Promise<{ buckets: DateBucket[]; totalReview: number }> {
  const conf = schema.imageDateInference.confidence;
  const dirCol = schema.assets.directoryPath;

  const grouped = await db
    .select({
      dir: dirCol,
      count: sql<number>`count(*)::int`,
      avgConf: sql<number>`avg(${conf})::float8`,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(and(baseWhere(workspaceId), reviewBandSql()))
    .groupBy(dirCol);

  const totalReview = grouped.reduce((a, g) => a + g.count, 0);
  grouped.sort((a, b) => b.count - a.count);

  const buckets: DateBucket[] = [];
  for (const g of grouped.slice(0, MAX_AXIS_BUCKETS)) {
    const key = dirBucketKey(g.dir);
    buckets.push({
      bucketKey: key,
      axis: "folder",
      evidenceSource: null,
      conflict: false,
      reasonLabel: g.dir ?? "Files with no folder",
      count: g.count,
      confidenceTier: tierOf(g.avgConf ?? 0),
      sample: await sampleForPredicate(workspaceId, predicateForKey(key)),
    });
  }
  return { buckets, totalReview };
}

// Time axis — 72h-gap session clusters on captured_at. One cheap indexed pull of
// (assetId, captured_at, confidence) over the review band, clustered in JS; the
// top-N clusters by count each get a bounded sample SELECT. Null captured_at →
// one "No date yet" bucket.
async function listTimeBuckets(
  workspaceId: string
): Promise<{ buckets: DateBucket[]; totalReview: number }> {
  const conf = schema.imageDateInference.confidence;
  const capCol = schema.assets.capturedAt;

  const rows = await db
    .select({ capturedAt: capCol, confidence: conf })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(and(baseWhere(workspaceId), reviewBandSql()));

  const totalReview = rows.length;

  const dated = rows
    .filter((r) => r.capturedAt != null)
    .map((r) => ({ ms: new Date(r.capturedAt as Date).getTime(), conf: r.confidence }))
    .sort((a, b) => a.ms - b.ms);
  const nullCount = rows.length - dated.length;

  type Cluster = { startMs: number; endMs: number; count: number; sumConf: number };
  const clusters: Cluster[] = [];
  let cur: Cluster | null = null;
  for (const d of dated) {
    if (cur && d.ms - (cur.endMs - 1) <= TIME_GAP_MS) {
      cur.endMs = d.ms + 1;
      cur.count++;
      cur.sumConf += d.conf;
    } else {
      cur = { startMs: d.ms, endMs: d.ms + 1, count: 1, sumConf: d.conf };
      clusters.push(cur);
    }
  }
  clusters.sort((a, b) => b.count - a.count);

  const buckets: DateBucket[] = [];
  for (const c of clusters.slice(0, MAX_AXIS_BUCKETS)) {
    const key = timeBucketKey(c.startMs, c.endMs);
    buckets.push({
      bucketKey: key,
      axis: "time",
      evidenceSource: null,
      conflict: false,
      reasonLabel: timeRangeLabel(c.startMs, c.endMs),
      count: c.count,
      confidenceTier: tierOf(c.sumConf / c.count),
      sample: await sampleForPredicate(workspaceId, predicateForKey(key)),
    });
  }
  if (nullCount > 0) {
    const key = timeBucketKey(null);
    buckets.push({
      bucketKey: key,
      axis: "time",
      evidenceSource: null,
      conflict: false,
      reasonLabel: "No date yet",
      count: nullCount,
      confidenceTier: "low",
      sample: await sampleForPredicate(workspaceId, predicateForKey(key)),
    });
  }
  return { buckets, totalReview };
}

/**
 * Onboarding progress — how far inference has drained for this workspace's
 * images. Drives the "Sorting your library… X of Y" banner. `sorted` counts
 * active image assets that have an inference row (any status); `total` counts
 * all active image assets.
 */
export async function getSortingProgress(
  workspaceId: string
): Promise<{ sorted: number; total: number }> {
  const isImage = sql`${schema.assets.mimeType} like 'image/%'`;
  const [t] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.assets)
    .where(and(eq(schema.assets.workspaceId, workspaceId), eq(schema.assets.lifecycleState, "active"), isImage));
  const [s] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(and(eq(schema.assets.workspaceId, workspaceId), eq(schema.assets.lifecycleState, "active"), isImage));
  return { sorted: s?.n ?? 0, total: t?.n ?? 0 };
}

export interface BucketApplyOpts {
  bucketKey: string;
  action: BucketAction;
  batchSize?: number;
  /** Safety cap on rows actioned in one apply (0 = no cap). */
  maxRows?: number;
}

export interface BucketApplyResult {
  workspaceId: string;
  bucketKey: string;
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
  const { bucketKey, action } = opts;
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? 200));
  const maxRows = opts.maxRows ?? 0;
  const log = logger.child({ component: "reconcile.bucket", workspaceId, action });

  const matchWhere = and(baseWhere(workspaceId), reviewBandSql(), predicateForKey(bucketKey));

  let applied = 0;
  for (;;) {
    if (maxRows && applied >= maxRows) break;
    const take = maxRows ? Math.min(batchSize, maxRows - applied) : batchSize;
    const batch = await db
      .select({
        assetId: schema.imageDateInference.assetId,
        mapEstimate: schema.imageDateInference.mapEstimate,
        capturedAt: schema.assets.capturedAt,
      })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(matchWhere)
      .limit(take);
    if (batch.length === 0) break;

    await db.transaction(async (tx) => {
      for (const row of batch) {
        // Snapshot the pre-action state so the UI can undo this bulk apply.
        const undo = {
          priorStatus: "inferred",
          priorCapturedAt: row.capturedAt ? new Date(row.capturedAt).toISOString() : null,
        };
        // Only act if WE flip the row (guards a racing apply / re-fuse).
        const upd = await tx
          .update(schema.imageDateInference)
          .set({ status: ACTION_STATUS[action], reviewUndo: undo })
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

  log.info({ applied, bucketKey }, "bucket reconcile applied");
  return { workspaceId, bucketKey, action, applied };
}

/**
 * Reverse the most recent bulk action on a bucket: every row carrying an undo
 * snapshot (review_undo) for this bucket is restored to its prior status +
 * captured_at, and the snapshot is cleared. Batched + resumable, mirroring the
 * forward apply. Only rows we bulk-actioned (review_undo IS NOT NULL) move.
 */
export async function applyBucketUndo(
  workspaceId: string,
  opts: { bucketKey: string; batchSize?: number }
): Promise<{ workspaceId: string; bucketKey: string; reverted: number }> {
  const { bucketKey } = opts;
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? 200));
  const log = logger.child({ component: "reconcile.bucketUndo", workspaceId });

  // No review-band filter here — actioned rows have left the 'inferred' band;
  // membership comes from the frozen bucketKey + a present undo snapshot.
  const matchWhere = and(
    eq(schema.assets.workspaceId, workspaceId),
    predicateForKey(bucketKey),
    sql`${schema.imageDateInference.reviewUndo} is not null`
  );

  let reverted = 0;
  for (;;) {
    const batch = await db
      .select({
        assetId: schema.imageDateInference.assetId,
        reviewUndo: schema.imageDateInference.reviewUndo,
      })
      .from(schema.imageDateInference)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
      .where(matchWhere)
      .limit(batchSize);
    if (batch.length === 0) break;

    await db.transaction(async (tx) => {
      for (const row of batch) {
        const u = (row.reviewUndo ?? {}) as { priorStatus?: string; priorCapturedAt?: string | null };
        const priorStatus = u.priorStatus ?? "inferred";
        const upd = await tx
          .update(schema.imageDateInference)
          .set({ status: priorStatus, reviewUndo: null })
          .where(
            and(
              eq(schema.imageDateInference.assetId, row.assetId),
              sql`${schema.imageDateInference.reviewUndo} is not null`
            )
          )
          .returning({ assetId: schema.imageDateInference.assetId });
        if (upd.length === 0) continue;
        // Restore the pre-action captured_at (a no-op for reject/quarantine,
        // which never wrote it; restores the overwritten date for confirm).
        await tx
          .update(schema.assets)
          .set({ capturedAt: u.priorCapturedAt ? new Date(u.priorCapturedAt) : null })
          .where(and(eq(schema.assets.id, row.assetId), eq(schema.assets.workspaceId, workspaceId)));
        reverted++;
      }
    });
    if (batch.length < batchSize) break;
  }

  log.info({ reverted, bucketKey }, "bucket undo applied");
  return { workspaceId, bucketKey, reverted };
}
