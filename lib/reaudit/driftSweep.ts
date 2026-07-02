import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { inferDateQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";

const STALE_DAYS = parseInt(process.env.DRIFT_SWEEP_STALE_DAYS ?? "7", 10);

export async function runDriftSweep() {
  const stale = await db
    .select({ assetId: schema.imageDateInference.assetId })
    .from(schema.imageDateInference)
    .where(
      sql`${schema.imageDateInference.status} = 'inferred' AND ${schema.imageDateInference.computedAt} < now() - (${STALE_DAYS}::int || ' days')::interval`
    );

  for (const { assetId } of stale) {
    await inferDateQueue().add(JobNames.InferDate, { assetId }, { jobId: `drift:${assetId}` });
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
    stale_requeued: stale.length,
    queue_size: queueSize,
    correction_rate_24h: corrections ?? 0,
  }));
}
