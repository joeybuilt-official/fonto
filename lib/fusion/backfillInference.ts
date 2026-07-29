// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4. Backfill sweep: enqueue an infer-date job for
// each asset that HAS evidence rows but NO inference proposal yet. Bounded +
// resumable (a computed asset gets an image_date_inference row and drops out of
// the NOT EXISTS probe). Default-OFF (env-gated) like the Phase 3 sweeps.

import { eq, notExists, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { inferDateQueue } from "@/lib/queue/queues";
import { JobNames } from "@/lib/queue/jobs";

export async function backfillInference(batchSize: number): Promise<{ enqueued: number }> {
  const log = logger.child({ component: "fusion.backfill" });

  // Assets with at least one evidence row but no inference proposal yet.
  const candidates = await db
    .selectDistinct({ assetId: schema.imageDateEvidence.assetId })
    .from(schema.imageDateEvidence)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(schema.imageDateInference)
          .where(eq(schema.imageDateInference.assetId, schema.imageDateEvidence.assetId))
      )
    )
    .limit(batchSize);

  for (const c of candidates) {
    await inferDateQueue().add(JobNames.InferDate, { assetId: c.assetId });
  }
  log.info({ enqueued: candidates.length, batchSize }, "inference backfill tick");
  return { enqueued: candidates.length };
}
