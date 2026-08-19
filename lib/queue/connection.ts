// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared ioredis connection for BullMQ. BullMQ requires
// `maxRetriesPerRequest: null` and `enableReadyCheck: false` is recommended for
// workers/queues so they don't crash on transient blips.
//
// Default URL is `redis://valkey:6379` to line up with the platform's Valkey
// instance.
//
// The connection is LAZY. `next build` imports every route module to collect
// its metadata, and ~30 of them reach `lib/cache/valkey` -> here. With an
// eager connection that import opened a TCP socket during the build, where
// REDIS_URL is unset and the default host does not resolve; combined with
// `maxRetriesPerRequest: null` (infinite retries, required by BullMQ) it
// retried forever, wrote ~90k `ENOTFOUND valkey` lines into the build log and
// held the event loop open so the build could not exit. Deferring the socket
// to the first command costs nothing at runtime — every caller issues a
// command immediately — and makes module import free.

import IORedis, { type RedisOptions } from "ioredis";

let _connection: IORedis | null = null;

export function getRedisUrl(): string {
  return process.env.REDIS_URL ?? "redis://valkey:6379";
}

export function getRedisConnection(): IORedis {
  if (_connection) return _connection;
  const url = getRedisUrl();
  const opts: RedisOptions = {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  };
  _connection = new IORedis(url, opts);
  // ioredis emits `error` on every failed reconnect attempt; with no listener
  // that becomes an unhandled 'error' event and takes the process down. The
  // cache layer already fails open, and BullMQ surfaces its own errors, so
  // swallowing here keeps a Valkey outage a degradation rather than a crash.
  _connection.on("error", () => undefined);
  return _connection;
}

/** Close the shared connection. Called from worker shutdown. */
export async function closeRedisConnection(): Promise<void> {
  if (_connection) {
    await _connection.quit().catch(() => undefined);
    _connection = null;
  }
}
