// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared ioredis connection for BullMQ. BullMQ requires
// `maxRetriesPerRequest: null` and `enableReadyCheck: false` is recommended for
// workers/queues so they don't crash on transient blips.
//
// Default URL is `redis://valkey:6379` to line up with the platform's Valkey
// instance.

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
    lazyConnect: false,
  };
  _connection = new IORedis(url, opts);
  return _connection;
}

/** Close the shared connection. Called from worker shutdown. */
export async function closeRedisConnection(): Promise<void> {
  if (_connection) {
    await _connection.quit().catch(() => undefined);
    _connection = null;
  }
}
