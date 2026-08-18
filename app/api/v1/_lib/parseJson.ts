// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared JSON body parser for v1 route handlers. A bare `await request.json()`
// throws on a malformed or empty body, which surfaces as an unhandled 500
// rather than a validation 400 — inconsistent with the routes (shares,
// export/zip) that already guard it. `parseJson` centralises the guard so the
// public API returns a uniform 400 envelope for bad JSON.
//
// Lives under `_lib/` (an App Router "private folder") so Next.js never treats
// it as a route.
import { NextResponse } from "next/server";

export type ParseJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Parse a request body as JSON. On success returns `{ ok: true, data }`; on a
 * malformed/empty body returns `{ ok: false, response }` carrying the canonical
 * 400 envelope so callers stay one-liners:
 *
 *   const parsed = await parseJson<{ name?: string }>(request);
 *   if (!parsed.ok) return parsed.response;
 *   const body = parsed.data;
 */
export async function parseJson<T = unknown>(
  request: Request
): Promise<ParseJsonResult<T>> {
  try {
    const data = (await request.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }),
    };
  }
}
