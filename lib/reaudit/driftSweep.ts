import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { inferDateQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";

const STALE_DAYS = parseInt(process.env.DRIFT_SWEEP_STALE_DAYS ?? "7", 10);
/**
 * Ceiling on jobs enqueued per sweep.
 *
 * The select is unbounded and the sweep runs every 24h. Measured on prod
 * 2026-09-08: 160,990 rows qualify — so an unbounded first run would enqueue
 * that many jobs in one burst. `inferAssetDate` is pure domain work over
 * Postgres (no model, no network), so this is database load rather than GPU
 * load, but a six-figure burst still deserves a ceiling the operator can raise.
 */
const MAX_PER_RUN = parseInt(process.env.DRIFT_SWEEP_MAX_PER_RUN ?? "5000", 10);

export async function runDriftSweep() {
  const stale = await db
    .select({ assetId: schema.imageDateInference.assetId })
    .from(schema.imageDateInference)
    .where(
      sql`${schema.imageDateInference.status} = 'inferred' AND ${schema.imageDateInference.computedAt} < now() - (${STALE_DAYS}::int || ' days')::interval`
    );

  // jobId uses '-', never ':'. BullMQ rejects a custom id containing a colon
  // ("Custom Id cannot contain :"), and because this add was unguarded the
  // throw aborted the ENTIRE sweep on its first row — every run since the
  // pinned-jobId change, surfacing only as an "unhandled rejection" in the
  // worker log. The sweep has therefore never requeued anything.
  const batch = stale.slice(0, MAX_PER_RUN);
  let requeued = 0;
  const queue = inferDateQueue();
  for (const { assetId } of batch) {
    try {
      await queue.add(JobNames.InferDate, { assetId }, { jobId: `drift-${assetId}` });
      requeued++;
    } catch {
      // Already queued (a sibling replica got there first) or a transient redis
      // hiccup. Neither is a reason to abandon the remaining rows.
    }
  }

  const queueSize = await inferDateQueue().getWaitingCount();
  const [{ corrections }] = await db
    .select({ corrections: sql<number>`count(*)::int` })
    .from(schema.imageDateInference)
    .where(
      sql`${schema.imageDateInference.status} = 'confirmed' AND ${schema.imageDateInference.computedAt} > now() - interval '24 hours'`
    );

  console.log(JSON.stringify({
    event: "drift_sweep",
    stale_candidates: stale.length,
    stale_requeued: requeued,
    queue_size: queueSize,
    correction_rate_24h: corrections ?? 0,
  }));
}
