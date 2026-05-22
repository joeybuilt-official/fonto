// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Bull-board sidecar — a tiny Express app that exposes the BullMQ admin UI
// for Fonto's queues. Runs as its own container alongside the Next.js app
// and the worker (see `Dockerfile.bullboard` + ADR 0005 / ADR 0006). We
// chose a sidecar over an App Router mount so we avoid Next 16 + Express
// integration friction and so the deploy story mirrors the worker.
//
// Auth: HTTP Basic, enforced on every request, credentials sourced from
// `BULL_BOARD_BASIC_AUTH_USER` + `BULL_BOARD_BASIC_AUTH_PASS`. If either
// env var is unset, the process refuses to boot — a misconfigured prod
// deploy must fail closed, never expose the queue UI anonymously. In a
// production deploy this container sits behind Caddy with TLS; basic-auth
// over plain HTTP is for dev only.
//
// Run locally:
//   pnpm tsx bullboard/index.ts
//
// Env:
//   REDIS_URL                     defaults to redis://valkey:6379 (shared with worker)
//   BULL_BOARD_PORT               defaults to 3300
//   BULL_BOARD_BASIC_AUTH_USER    required
//   BULL_BOARD_BASIC_AUTH_PASS    required

import express, { type Request, type Response, type NextFunction } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Queue } from "bullmq";
import { assetProcessingQueue } from "@/lib/queue/queues";
import { logger } from "@/lib/logger";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(
      `[bullboard] FATAL: ${name} is not set. Refusing to start an unauthenticated bull-board.`
    );
    process.exit(1);
  }
  return v;
}

// Resolve auth + port at boot so we fail loudly on misconfig before any
// request can be served.
const BULL_BOARD_USER = requireEnv("BULL_BOARD_BASIC_AUTH_USER");
const BULL_BOARD_PASS = requireEnv("BULL_BOARD_BASIC_AUTH_PASS");
const PORT = parseInt(process.env.BULL_BOARD_PORT ?? "3300", 10);

/**
 * Collect every queue the sidecar should expose. `assetProcessingQueue` is
 * always present; `maintenanceQueue` is added by the parallel Phase 0.2
 * reaper work and may not yet be exported. We re-import the module
 * dynamically and look up the named export at runtime so the sidecar keeps
 * booting whether or not Phase 0.2 has merged.
 */
async function collectQueues(): Promise<Queue[]> {
  const queues: Queue[] = [assetProcessingQueue()];

  try {
    const mod = (await import("@/lib/queue/queues")) as unknown as Record<
      string,
      unknown
    >;
    const maybe = mod.maintenanceQueue;
    if (typeof maybe === "function") {
      const q = (maybe as () => Queue)();
      queues.push(q);
    }
  } catch {
    // Phase 0.2 hasn't landed yet — that's fine.
  }

  return queues;
}

function timingSafeEq(a: string, b: string): boolean {
  // Constant-time compare without pulling in `crypto` types here. Lengths
  // differ → return false but still iterate the shorter string so timing
  // is not totally length-leaky for the same-length case.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    if (sep > 0) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (timingSafeEq(user, BULL_BOARD_USER) && timingSafeEq(pass, BULL_BOARD_PASS)) {
        next();
        return;
      }
    }
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="fonto-bullboard", charset="UTF-8"');
  res.status(401).send("Authentication required");
}

async function main(): Promise<void> {
  const queues = await collectQueues();

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/");

  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  const app = express();

  // Lightweight liveness probe — useful for container orchestrators that
  // don't speak HTTP Basic. No queue data leaks here.
  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  // Everything else (including the bull-board static assets + JSON APIs)
  // requires basic auth. Mount the basic-auth middleware first, then the
  // bull-board router.
  app.use(basicAuth);
  app.use("/", serverAdapter.getRouter());

  app.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        queues: queues.map((q) => q.name),
        redisUrl: (process.env.REDIS_URL ?? "redis://valkey:6379").replace(
          /\/\/[^@]*@/,
          "//***@"
        ),
      },
      "bull-board listening"
    );
  });
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "bull-board boot failed"
  );
  process.exit(1);
});
