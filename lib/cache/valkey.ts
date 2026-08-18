// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// T2.1 / T2.2 — Shared Valkey cache primitive.
//
// One ioredis connection across the whole process: we re-use the BullMQ
// connection from `lib/queue/connection.ts` to avoid opening a second TCP
// socket per pod (BullMQ already keeps it warm).
//
// Key shape (`cache:` namespace, kept distinct from BullMQ's `bull:`):
//   cache:<key>                 — the cached payload (JSON-encoded)
//   cache:lock:<key>            — SETNX stampede lock; holds the writer's
//                                 request id, EX 30s
//   cache:tag:<tag>             — SET of keys carrying that tag; used by
//                                 invalidateTag for O(SET) deletion
//
// Failure policy: ALL public methods fail OPEN. A Valkey outage degrades to
// the current (uncached) behaviour — we never propagate a Redis error up to
// the API layer and turn a cache miss into a 500.
//
// Tradeoffs documented inline at the stampede-lock loop.

import IORedis from "ioredis";
import { randomUUID } from "crypto";
import { getRedisUrl } from "@/lib/queue/connection";
import {
  cacheEvictionsTotal,
  cacheHitsTotal,
  cacheMissesTotal,
  cacheStampedeWaitsTotal,
  wsLabel,
} from "./metrics";

const KEY_PREFIX = "cache:";
const LOCK_PREFIX = "cache:lock:";
const TAG_PREFIX = "cache:tag:";

const DEFAULT_LOCK_TTL_SEC = 30;
const STAMPEDE_POLL_MS = 50;
const STAMPEDE_MAX_WAIT_MS = 3_000;

export interface GetOrComputeOpts {
  /** Tags to register this key under. Used by invalidateTag(). */
  tags?: string[];
  /** Short cache name for metrics, e.g. "search" / "tags". */
  cacheName: string;
  /** Optional workspace label for hit/miss counters. */
  workspaceId?: string;
}

export interface CacheLayer<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttlSec: number, tags?: string[]): Promise<void>;
  invalidateTag(tag: string): Promise<number>;
  getOrCompute(
    key: string,
    ttlSec: number,
    compute: () => Promise<T>,
    opts: GetOrComputeOpts,
  ): Promise<T>;
}

// DEDICATED cache-tier connection — deliberately NOT the shared BullMQ
// connection (lib/queue/connection.ts). BullMQ requires
// `maxRetriesPerRequest: null` and relies on ioredis's default
// `enableOfflineQueue: true`, which means during a mid-session Valkey outage
// commands are QUEUED offline and the awaited get/set/eval never rejects — so
// the fail-open try/catch in every helper below never runs and the request
// HANGS until reconnect (turning a cache-tier blip into stalled search / tags
// / persons requests). This connection sets `enableOfflineQueue: false` +
// `commandTimeout` so a command REJECTS fast when Valkey is unreachable,
// letting the fail-open catch degrade to direct compute as the module policy
// promises.
const CACHE_COMMAND_TIMEOUT_MS = 250;
let _cacheRedis: IORedis | null = null;

function safeRedis(): IORedis | null {
  if (_cacheRedis) return _cacheRedis;
  try {
    const conn = new IORedis(getRedisUrl(), {
      enableOfflineQueue: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      lazyConnect: false,
    });
    // A cache-tier connection must never crash the process on a transient
    // Valkey error (unhandled 'error' events are fatal in Node) — every
    // command is already guarded by a fail-open try/catch, so swallow here.
    conn.on("error", () => {});
    _cacheRedis = conn;
    return _cacheRedis;
  } catch {
    return null;
  }
}

function nsKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

function lockKey(key: string): string {
  return `${LOCK_PREFIX}${key}`;
}

function tagKey(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

async function safeGetJSON<T>(redis: IORedis, key: string): Promise<T | null> {
  try {
    const raw = await redis.get(nsKey(key));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function safeSetJSON<T>(
  redis: IORedis,
  key: string,
  value: T,
  ttlSec: number,
  tags: string[],
): Promise<void> {
  try {
    const payload = JSON.stringify(value);
    // Pipeline: SET payload + add key to each tag SET in one round-trip.
    const pipeline = redis.pipeline();
    pipeline.set(nsKey(key), payload, "EX", ttlSec);
    for (const tag of tags) {
      pipeline.sadd(tagKey(tag), nsKey(key));
      // Tag-set TTL: outlive the payload so we never lose the bookkeeping
      // before the payload itself expires (Valkey doesn't refresh TTL on
      // SADD). Bump by 10x — far cheaper than a stuck tag entry.
      pipeline.expire(tagKey(tag), Math.max(ttlSec * 10, 600));
    }
    await pipeline.exec();
  } catch {
    // fail open — the caller already has the computed value, the cache
    // simply doesn't get warmed.
  }
}

/**
 * Delete every key bearing the given tag. O(set-size) — bounded by how many
 * cached entries that tag has touched, never O(KEYS).
 */
async function safeInvalidateTag(redis: IORedis, tag: string, cacheName: string): Promise<number> {
  try {
    const members = await redis.smembers(tagKey(tag));
    if (members.length === 0) {
      await redis.del(tagKey(tag)).catch(() => undefined);
      return 0;
    }
    const pipeline = redis.pipeline();
    pipeline.del(...members);
    pipeline.del(tagKey(tag));
    const results = await pipeline.exec();
    // First entry is the result of DEL on the data keys — that's the count.
    const delResult = results?.[0]?.[1] as number | undefined;
    const deleted = typeof delResult === "number" ? delResult : members.length;
    if (deleted > 0) {
      cacheEvictionsTotal.labels({ cache: cacheName, reason: "mutation" }).inc(deleted);
    }
    return deleted;
  } catch {
    return 0;
  }
}

class ValkeyCacheLayer<T> implements CacheLayer<T> {
  async get(key: string): Promise<T | null> {
    const redis = safeRedis();
    if (!redis) return null;
    return safeGetJSON<T>(redis, key);
  }

  async set(key: string, value: T, ttlSec: number, tags: string[] = []): Promise<void> {
    const redis = safeRedis();
    if (!redis) return;
    await safeSetJSON(redis, key, value, ttlSec, tags);
  }

  async invalidateTag(tag: string): Promise<number> {
    const redis = safeRedis();
    if (!redis) return 0;
    // Use the tag itself as the cache-label fallback. Callers that want a
    // more specific label can call the underlying helper.
    return safeInvalidateTag(redis, tag, tag);
  }

  async getOrCompute(
    key: string,
    ttlSec: number,
    compute: () => Promise<T>,
    opts: GetOrComputeOpts,
  ): Promise<T> {
    const { cacheName, workspaceId, tags = [] } = opts;
    const wsLbl = wsLabel(workspaceId);
    const redis = safeRedis();

    // No Valkey, or the connection isn't currently ready (mid-outage /
    // reconnecting / still connecting at cold start)? Skip straight to compute
    // so we never enter the stampede-lock wait against a dead socket — with
    // enableOfflineQueue:false the SETNX would reject and we'd otherwise poll
    // the full STAMPEDE_MAX_WAIT_MS before falling back. Not counted as a miss
    // — the metric is about cache effectiveness, not Valkey health (covered
    // separately by the prom-client default process metrics).
    if (!redis || redis.status !== "ready") return compute();

    // Fast path — cache hit.
    const cached = await safeGetJSON<T>(redis, key);
    if (cached !== null) {
      cacheHitsTotal.labels({ cache: cacheName, workspace_id: wsLbl }).inc();
      return cached;
    }

    cacheMissesTotal.labels({ cache: cacheName, workspace_id: wsLbl }).inc();

    // Stampede lock — SETNX with a request id. Winner computes; losers poll
    // for the cached key (NOT the lock — we want the payload). Bounded wait
    // so a misbehaving compute() can't pin a request for >3s; on timeout the
    // loser falls back to its own compute() call (degraded, but never
    // hung).
    const reqId = randomUUID();
    const lockK = lockKey(key);
    let acquired = false;
    try {
      const setResult = await redis.set(
        lockK,
        reqId,
        "EX",
        DEFAULT_LOCK_TTL_SEC,
        "NX",
      );
      acquired = setResult === "OK";
    } catch {
      acquired = false;
    }

    if (!acquired) {
      cacheStampedeWaitsTotal.labels({ cache: cacheName }).inc();
      const deadline = Date.now() + STAMPEDE_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, STAMPEDE_POLL_MS));
        const peek = await safeGetJSON<T>(redis, key);
        if (peek !== null) return peek;
      }
      // Lock holder is slow or died — degrade to our own compute(). We
      // intentionally do NOT try to acquire the lock here: the winner may
      // still be racing and we'd rather take a duplicate DB hit than starve.
      return compute();
    }

    try {
      const value = await compute();
      await safeSetJSON(redis, key, value, ttlSec, tags);
      return value;
    } finally {
      // Best-effort lock release. We only DEL if the value matches reqId
      // so a slow compute() that exceeded the lock TTL doesn't yank a
      // newer holder's lock. Lua script keeps the check-and-delete atomic.
      try {
        await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          1,
          lockK,
          reqId,
        );
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Default singleton. JSON-only payloads (no Buffer, no Date — serialize to
 * ISO strings first if you need them). Re-instantiating per generic param is
 * cheap because there's no per-instance state.
 */
export function getCacheLayer<T = unknown>(): CacheLayer<T> {
  return new ValkeyCacheLayer<T>();
}

/**
 * Mutation-event entry point. Call from any /api/v1/* route that changes a
 * workspace-scoped catalogue. Fire-and-forget — never await in a hot path
 * that's already committed the DB write; we don't want a Valkey blip to
 * delay the API response. We DO log the deleted count back to the metric so
 * Prom can see the eviction.
 *
 * Convention for tags (matches the T1.3 parallel work so the two layers
 * never drift):
 *   ws:<workspaceId>:assets             — invalidate search results
 *   ws:<workspaceId>:tags               — tag catalogue
 *   ws:<workspaceId>:collections        — collection catalogue
 *   ws:<workspaceId>:persons            — persons list with thumb
 *   ws:<workspaceId>:smart_collections  — smart-collection catalogue
 */
export async function cacheInvalidate(tag: string): Promise<number> {
  const redis = safeRedis();
  if (!redis) return 0;
  // Map tag → metric cache-label so the eviction shows up against the right
  // series. Anything else uses the raw tag.
  const cacheName = inferCacheNameFromTag(tag);
  return safeInvalidateTag(redis, tag, cacheName);
}

function inferCacheNameFromTag(tag: string): string {
  // tag shape: ws:<uuid>:<resource>
  const idx = tag.lastIndexOf(":");
  if (idx < 0 || idx === tag.length - 1) return tag;
  const resource = tag.slice(idx + 1);
  switch (resource) {
    case "assets":
      return "search";
    case "tags":
    case "collections":
    case "persons":
    case "smart_collections":
      return resource;
    default:
      return tag;
  }
}
