// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Prometheus scrape endpoint. Authenticated with a static bearer token from
// `METRICS_BEARER_TOKEN`. We refuse to ever serve metrics anonymously: if the
// env var is unset, this route returns 503 — Prom never exposes /metrics in
// the open by accident.
//
// Pinned to the Node.js runtime because `prom-client` uses Node APIs
// (perf_hooks, process metrics, etc.) and the queue-depth poller imports
// bullmq/ioredis.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { register } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export async function GET(request: NextRequest): Promise<Response> {
  const expected = process.env.METRICS_BEARER_TOKEN;
  if (!expected) {
    // Fail-closed: an unset token means metrics are off, not open.
    return new NextResponse("metrics endpoint disabled (METRICS_BEARER_TOKEN unset)", {
      status: 503,
    });
  }

  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  // Constant-time compare: `!==` early-exits and leaks token length + a
  // per-character timing signal. Length-check first (timingSafeEqual throws on
  // unequal-length Buffers), then compare.
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (
    !presented ||
    presentedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const body = await register.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": PROM_CONTENT_TYPE,
      "Cache-Control": "no-store",
    },
  });
}
