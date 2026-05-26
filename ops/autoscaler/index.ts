// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 9b — fonto-worker autoscaler (C2: queue-depth signal).
//
// Tick:
//   1. Read waiting+delayed job counts for the watched queues from
//      Valkey (default: asset-processing, thumbnails, clip-embedding,
//      face-detect, ocr — the throughput-bound ones).
//   2. Compute target replicas from total depth:
//        depth <  scale_down_threshold (5)  → target = floor (1)
//        depth >  scale_up_threshold   (20) → target = current + 1
//        otherwise → target = current (hold)
//   3. Clamp to [FLOOR, CEILING] (default 1..4).
//   4. Dampen: if a scale action ran less than DAMPENING_MS ago, hold.
//   5. Shell out to `docker compose -f $COMPOSE_FILE up -d --scale
//      fonto-worker=N` to reconcile. In DRY_RUN=1 mode, log the
//      decision and skip the call.
//
// Design notes:
//   - Tick interval defaults to 30s — frequent enough to react to a
//     burst, infrequent enough that BullMQ stats are stable.
//   - 60s dampening prevents thrash when depth oscillates around a
//     threshold.
//   - Compose is invoked because it's the simplest "create the Nth
//     replica from the same template" surface — the alternative is to
//     reach into the Docker Engine API + clone the container spec,
//     which roughly doubles the LOC for no operational benefit.
//   - The container needs the host docker socket + the compose file
//     read-only mounted in. See ops/autoscaler/README.md.

import IORedis from "ioredis";
import { Queue } from "bullmq";
import { spawn } from "node:child_process";

const QUEUES_TO_WATCH = (
  process.env.AUTOSCALER_QUEUES ??
  "asset-processing,thumbnails,clip-embedding,face-detect,ocr"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TICK_INTERVAL_MS = numEnv("AUTOSCALER_TICK_MS", 30_000, 1_000);
const SCALE_UP_THRESHOLD = numEnv("AUTOSCALER_SCALE_UP", 20, 1);
const SCALE_DOWN_THRESHOLD = numEnv("AUTOSCALER_SCALE_DOWN", 5, 0);
const FLOOR = numEnv("AUTOSCALER_FLOOR", 1, 1);
const CEILING = numEnv("AUTOSCALER_CEILING", 4, 1);
const DAMPENING_MS = numEnv("AUTOSCALER_DAMPENING_MS", 60_000, 0);
const DRY_RUN = process.env.AUTOSCALER_DRY_RUN === "1";
const COMPOSE_FILE = process.env.AUTOSCALER_COMPOSE_FILE ?? "/etc/fonto-compose/docker-compose.yml";
const WORKER_SERVICE = process.env.AUTOSCALER_WORKER_SERVICE ?? "fonto-worker";
const REDIS_URL = process.env.REDIS_URL ?? "redis://valkey:6379";

function numEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

let lastScaleAt = 0;
let currentReplicas = FLOOR;

function log(level: "info" | "warn" | "error", msg: string, ctx: Record<string, unknown> = {}) {
  const line = {
    component: "autoscaler",
    level,
    ts: new Date().toISOString(),
    msg,
    ...ctx,
  };
  console.log(JSON.stringify(line));
}

async function queueDepth(redis: IORedis): Promise<{ total: number; per: Record<string, number> }> {
  const per: Record<string, number> = {};
  let total = 0;
  for (const name of QUEUES_TO_WATCH) {
    const q = new Queue(name, { connection: redis });
    try {
      // Waiting = ready to run, delayed = scheduled. Both count toward
      // "backlog the workers will need to drain".
      const counts = await q.getJobCounts("wait", "delayed");
      const depth = (counts.wait ?? 0) + (counts.delayed ?? 0);
      per[name] = depth;
      total += depth;
    } catch (err) {
      log("warn", "queue_depth_failed", {
        queue: name,
        err: err instanceof Error ? err.message : String(err),
      });
      per[name] = 0;
    } finally {
      await q.close().catch(() => undefined);
    }
  }
  return { total, per };
}

function decideTarget(depth: number, current: number): number {
  if (depth >= SCALE_UP_THRESHOLD) return Math.min(current + 1, CEILING);
  if (depth <= SCALE_DOWN_THRESHOLD) return Math.max(current - 1, FLOOR);
  return current;
}

function applyScale(target: number): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      "compose",
      "-f",
      COMPOSE_FILE,
      "up",
      "-d",
      "--no-recreate",
      "--scale",
      `${WORKER_SERVICE}=${target}`,
      WORKER_SERVICE,
    ];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) {
        log("info", "scale_applied", { target, service: WORKER_SERVICE });
      } else {
        log("error", "scale_failed", {
          target,
          service: WORKER_SERVICE,
          exitCode: code,
          stderr: stderr.slice(0, 400),
        });
      }
      resolve();
    });
  });
}

async function tick(redis: IORedis): Promise<void> {
  const { total, per } = await queueDepth(redis);
  const target = decideTarget(total, currentReplicas);
  const sinceLastMs = Date.now() - lastScaleAt;

  if (target === currentReplicas) {
    log("info", "hold", { depth: total, current: currentReplicas, per });
    return;
  }
  if (sinceLastMs < DAMPENING_MS) {
    log("info", "dampened", {
      depth: total,
      current: currentReplicas,
      proposedTarget: target,
      dampeningMs: DAMPENING_MS,
      sinceLastMs,
    });
    return;
  }

  log("info", DRY_RUN ? "would_scale" : "scale", {
    depth: total,
    current: currentReplicas,
    target,
    dryRun: DRY_RUN,
    per,
  });

  if (!DRY_RUN) {
    await applyScale(target);
  }
  currentReplicas = target;
  lastScaleAt = Date.now();
}

async function main(): Promise<void> {
  log("info", "starting", {
    queues: QUEUES_TO_WATCH,
    tickMs: TICK_INTERVAL_MS,
    scaleUp: SCALE_UP_THRESHOLD,
    scaleDown: SCALE_DOWN_THRESHOLD,
    floor: FLOOR,
    ceiling: CEILING,
    dampeningMs: DAMPENING_MS,
    dryRun: DRY_RUN,
    composeFile: COMPOSE_FILE,
    workerService: WORKER_SERVICE,
  });

  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  let stopping = false;
  const onSignal = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutdown", { signal });
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));

  // Eager first tick so the operator sees a decision immediately.
  await tick(redis).catch((err) => {
    log("error", "tick_failed", { err: err instanceof Error ? err.message : String(err) });
  });

  while (!stopping) {
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
    if (stopping) break;
    await tick(redis).catch((err) => {
      log("error", "tick_failed", { err: err instanceof Error ? err.message : String(err) });
    });
  }
}

void main();
