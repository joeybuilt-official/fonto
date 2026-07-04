// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.4 — process-local LRU cache for CLIP text embeddings used by
// smart-collection `clipText` predicates.
//
// Why a cache: every smart-collection refresh that contains a `clipText`
// clause currently triggers a round-trip to the Plexo vision sidecar to
// embed the same phrase. Saved searches are rarely re-edited, so the
// embedding is stable for the lifetime of the saved query; caching the
// result for an hour cuts vision-sidecar load on smart-collection refresh
// to near zero.
//
// Why not Valkey/Redis: this is per-process, low-rate, ~512 floats per
// entry (~4 KB after JSON), and a stale entry only means one extra round-
// trip. A bounded in-memory Map is the right size for the problem.
//
// Eviction: classic LRU by insertion-order Map mutation. When the entry
// count exceeds CLIP_TEXT_CACHE_MAX (default 100), the oldest is dropped.
// Entries also expire after CLIP_TEXT_CACHE_TTL_MS (default 1 h) since
// the last embed.
//
// Keying: `${workspaceId}|${text}`. Workspace scoping is defensive — the
// embedding itself is workspace-independent (CLIP weights are global) but
// keying per workspace prevents one tenant's frequent saved searches from
// crowding out another tenant's during eviction.

import { intelligence } from "@/lib/intelligence/client";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX = 100;

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

interface CacheEntry {
  vector: number[];
  modelId: string;
  insertedAt: number;
}

const cache = new Map<string, CacheEntry>();

function ttlMs(): number {
  return readNumberEnv("CLIP_TEXT_CACHE_TTL_MS", DEFAULT_TTL_MS);
}

function maxEntries(): number {
  return readNumberEnv("CLIP_TEXT_CACHE_MAX", DEFAULT_MAX);
}

function cacheKey(workspaceId: string, text: string): string {
  return `${workspaceId}|${text}`;
}

function evictIfNeeded(): void {
  const max = maxEntries();
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/**
 * Returns the CLIP text embedding for `text`, cached per
 * `(workspaceId, text)`. On cache miss, embeds via the Plexo vision client
 * and stores the result. Stale entries (older than the TTL) are evicted on
 * access. Returns null if the embedding call throws — callers should treat
 * this as "vision unavailable" and skip the clipText predicate gracefully.
 */
export async function getCachedClipTextEmbedding(
  workspaceId: string,
  text: string
): Promise<{ vector: number[]; modelId: string } | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const key = cacheKey(workspaceId, trimmed);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.insertedAt < ttlMs()) {
    // Refresh LRU position: delete + reinsert moves the key to the most-
    // recently-used end of the Map's insertion order.
    cache.delete(key);
    cache.set(key, hit);
    return { vector: hit.vector, modelId: hit.modelId };
  }

  try {
    const embedded = await intelligence.embedText(trimmed);
    const entry: CacheEntry = {
      vector: [...embedded.vector],
      modelId: embedded.modelId,
      insertedAt: now,
    };
    cache.set(key, entry);
    evictIfNeeded();
    return { vector: entry.vector, modelId: entry.modelId };
  } catch {
    // Don't poison the cache with failures — callers degrade gracefully.
    return null;
  }
}

/** Test-only: drop every entry. */
export function _clearClipTextCacheForTests(): void {
  cache.clear();
}

/** Test-only: introspect cache size. */
export function _clipTextCacheSizeForTests(): number {
  return cache.size;
}
