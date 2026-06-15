// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// T1.9 — Cache observability. Counters/gauges for the Valkey cache layer.
// Registered against the shared `register` exported from `lib/metrics.ts` so
// they show up on the existing /api/metrics endpoint with no extra wiring.
//
// `cache` label values are the short names used at call sites:
//   - "search"          — /api/v1/search results
//   - "tags"            — workspace tag catalogue
//   - "collections"     — workspace collection catalogue
//   - "persons"         — workspace person list (with cover thumb)
//   - "smart-collections" — workspace smart-collection catalogue
// Keep label cardinality bounded — `workspace_id` is already a UUID which
// per-tenant Fonto deployments will see at low (<10s) cardinality, but if we
// ever onboard many tenants on one Prom we may want to drop the label.

import { Counter } from "prom-client";
import { register } from "@/lib/metrics";

export const cacheHitsTotal = new Counter({
  name: "fonto_cache_hits_total",
  help: "Total Valkey cache hits, by cache name and workspace.",
  labelNames: ["cache", "workspace_id"] as const,
  registers: [register],
});

export const cacheMissesTotal = new Counter({
  name: "fonto_cache_misses_total",
  help: "Total Valkey cache misses, by cache name and workspace.",
  labelNames: ["cache", "workspace_id"] as const,
  registers: [register],
});

export const cacheStampedeWaitsTotal = new Counter({
  name: "fonto_cache_stampede_waits_total",
  help:
    "Total requests that joined an in-flight cache rebuild via the SETNX lock " +
    "instead of doing the DB hit themselves.",
  labelNames: ["cache"] as const,
  registers: [register],
});

export const cacheEvictionsTotal = new Counter({
  name: "fonto_cache_evictions_total",
  help:
    "Total cache evictions, labelled by reason. `ttl` is observed only via the " +
    "miss counter today (Valkey doesn't notify us on expiry); `mutation` is " +
    "incremented from invalidateTag() per deleted key.",
  labelNames: ["cache", "reason"] as const,
  registers: [register],
});

/** Helper — workspaceId label coalescing for unauthenticated paths. */
export function wsLabel(workspaceId?: string): string {
  return workspaceId ?? "unknown";
}
