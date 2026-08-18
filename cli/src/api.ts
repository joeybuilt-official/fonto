// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Thin Fonto API client. All requests carry the PAT via the
// `Authorization: Bearer …` header that the server's API-key middleware
// recognises (PAT-auth is the CLI's only auth path; session cookies
// aren't in scope here).

import { getConfig } from "./config.js";

export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  processingState: string;
  capturedAt: string | null;
  createdAt: string;
  isFavorite?: boolean;
  rating?: number;
  directoryPath?: string | null;
  stackId?: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const cfg = getConfig();
  if (!cfg.pat) {
    throw new Error(
      "No PAT configured. Run `fonto login --pat <token>` (mint one at /app/settings/tokens)."
    );
  }
  const url = `${cfg.baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      // Abort hung / slow-loris servers instead of spinning forever.
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${cfg.pat}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new Error(`Request timed out after 30s (${url}).`);
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // Body wasn't JSON — keep the status-text message.
    }
    throw new ApiError(res.status, text, message);
  }
  // Every v1 endpoint returns a JSON body; an empty 200 (auth-proxy quirk,
  // 204-ish) would otherwise crash callers that destructure the result.
  if (text.length === 0) {
    throw new ApiError(res.status, text, "Server returned an empty response body");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // e.g. an SSO/auth proxy returning HTTP 200 with an HTML login page.
    const contentType = res.headers.get("content-type") ?? "unknown content-type";
    throw new ApiError(res.status, text, `Expected JSON but got ${contentType}`);
  }
}

export async function listAssets(opts: {
  mime?: string;
  limit?: number;
  favorite?: boolean;
}): Promise<{ assets: Asset[] }> {
  const sp = new URLSearchParams();
  if (opts.mime) sp.set("mime", opts.mime);
  if (opts.limit) sp.set("limit", String(opts.limit));
  if (opts.favorite) sp.set("favorite", "1");
  return request(`/api/v1/assets?${sp.toString()}`);
}

export async function search(q: string): Promise<{ assets: Asset[] }> {
  const sp = new URLSearchParams({ q });
  return request(`/api/v1/search?${sp.toString()}`);
}

export async function getStats(): Promise<{
  total: number;
  images: number;
  documents: number;
  videos: number;
  other: number;
  favorites: number;
  thisMonth: number;
}> {
  return request(`/api/v1/stats`);
}
