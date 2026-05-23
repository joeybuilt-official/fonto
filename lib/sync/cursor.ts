// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.3 — delta-sync cursor codec.
//
// The cursor a client sends back to `/sync/{assets,tags,collections}` is
// just the highest entity `seq` they've persisted. We expose it as a string
// (bigint serialization in JSON is a footgun) but validate it as a
// non-negative integer. No HMAC, no timestamp — the cursor space is per
// workspace and the seq values are not secrets.

export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 500;

export interface ParsedCursor {
  /** The highest seq the client has already received. 0n = start of stream. */
  value: bigint;
}

/**
 * Parse a `cursor` query parameter. Accepts null/undefined/empty to mean
 * "from the start of the stream" (value = 0n). Throws on invalid input so
 * the route handler can return a 400.
 */
export function parseCursor(raw: string | null | undefined): ParsedCursor {
  if (raw == null || raw === "") return { value: 0n };
  if (!/^\d+$/.test(raw)) {
    throw new SyncCursorError(`Invalid cursor: ${JSON.stringify(raw)}`);
  }
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new SyncCursorError(`Invalid cursor: ${JSON.stringify(raw)}`);
  }
  if (value < 0n) {
    throw new SyncCursorError("Cursor must be non-negative");
  }
  return { value };
}

/**
 * Encode a cursor for transport in JSON. bigint -> decimal string.
 */
export function encodeCursor(value: bigint): string {
  return value.toString();
}

/**
 * Parse `limit` query param, clamping into [1, MAX_PAGE_SIZE]. Empty/null =
 * DEFAULT_PAGE_SIZE.
 */
export function parseLimit(raw: string | null | undefined): number {
  if (raw == null || raw === "") return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new SyncCursorError(`Invalid limit: ${JSON.stringify(raw)}`);
  }
  if (n < 1) throw new SyncCursorError("limit must be >= 1");
  return Math.min(n, MAX_PAGE_SIZE);
}

export class SyncCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncCursorError";
  }
}
