// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 9b — autoscaler verification helper.
//
//   pnpm tsx ops/autoscaler/test-enqueue.ts [N|drain]
//
// `N` (default 100): enqueue N stub jobs into asset-processing. Used
// in concert with `AUTOSCALER_DRY_RUN=1` to watch the autoscaler tick
// up to CEILING. The jobs reference a fixed all-zero UUID — real
// workers will reject + dead-letter them quickly, which is fine for
// the verification window.
//
// `drain`: drain the queue (`obliterate`) so the autoscaler ticks
// back down toward FLOOR. Use this after the scale-up + scale-down
// curve is observed.

import IORedis from "ioredis";
import { Queue } from "bullmq";

const QUEUE = "asset-processing";
const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "100";
  const redis = new IORedis(process.env.REDIS_URL ?? "redis://valkey:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const q = new Queue(QUEUE, { connection: redis });

  if (arg === "drain") {
    await q.obliterate({ force: true });
    console.log(`drained queue=${QUEUE}`);
  } else {
    const n = Math.max(1, Number.parseInt(arg, 10) || 100);
    const jobs = Array.from({ length: n }, (_v, i) => ({
      name: "process-asset",
      data: {
        assetId: FAKE_UUID,
        workspaceId: FAKE_UUID,
        userId: "autoscaler-test",
        filename: `test-${i}.bin`,
        mimeType: "application/octet-stream",
      },
    }));
    await q.addBulk(jobs);
    console.log(`enqueued ${n} stub jobs onto queue=${QUEUE}`);
  }

  await q.close();
  await redis.quit();
}

void main();
