// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// The app's origin as a BROWSER sees it, for building absolute redirects.
//
// `request.nextUrl.origin` is not that origin in production: the standalone
// Next server is constructed with the container's bind address (HOSTNAME=0.0.0.0,
// PORT=3500), so behind the Cloudflare tunnel it yields `https://0.0.0.0:3500`
// — a URL no client can resolve (ERR_ADDRESS_INVALID). Prefer the configured
// public URL, then the proxy's forwarded host, and only then the caller's
// fallback.

/** Minimal read side of `Headers` — lets tests pass a plain object. */
export type HeaderLookup = { get(name: string): string | null };

/** First value of a possibly comma-joined proxy header. */
function first(value: string | null): string | null {
  if (!value) return null;
  const head = value.split(",")[0].trim();
  return head || null;
}

export function publicOrigin(headers: HeaderLookup, fallback: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = first(headers.get("x-forwarded-host")) ?? first(headers.get("host"));
  // A bind address in the Host header is the same failure this module exists to
  // avoid, so it never wins over the fallback.
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("[::]")) {
    return `${first(headers.get("x-forwarded-proto")) ?? "https"}://${host}`;
  }

  return fallback;
}
