// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Unit tests for the browser-visible origin resolver. The bug this guards
// against: an OAuth callback redirecting to `https://0.0.0.0:3500/...`, which
// the browser rejects with ERR_ADDRESS_INVALID.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publicOrigin } from "./publicOrigin";

const BIND_FALLBACK = "https://0.0.0.0:3500";

function headers(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  };
}

describe("publicOrigin", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.BETTER_AUTH_URL;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers NEXT_PUBLIC_APP_URL and strips trailing slashes", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://fonto.example.com//";
    expect(publicOrigin(headers({ host: "0.0.0.0:3500" }), BIND_FALLBACK)).toBe(
      "https://fonto.example.com"
    );
  });

  it("falls back to BETTER_AUTH_URL when the public URL is unset", () => {
    process.env.BETTER_AUTH_URL = "https://fonto.example.com";
    expect(publicOrigin(headers({}), BIND_FALLBACK)).toBe("https://fonto.example.com");
  });

  it("uses the forwarded host when no URL is configured", () => {
    const h = headers({
      "x-forwarded-host": "fonto.example.com",
      "x-forwarded-proto": "https",
      host: "0.0.0.0:3500",
    });
    expect(publicOrigin(h, BIND_FALLBACK)).toBe("https://fonto.example.com");
  });

  it("takes the first value of a comma-joined proxy chain", () => {
    const h = headers({
      "x-forwarded-host": "fonto.example.com, internal.local",
      "x-forwarded-proto": "https, http",
    });
    expect(publicOrigin(h, BIND_FALLBACK)).toBe("https://fonto.example.com");
  });

  it("assumes https when the proxy sends no protocol", () => {
    expect(publicOrigin(headers({ host: "fonto.example.com" }), BIND_FALLBACK)).toBe(
      "https://fonto.example.com"
    );
  });

  it("never builds an origin from a bind address in Host", () => {
    expect(publicOrigin(headers({ host: "0.0.0.0:3500" }), BIND_FALLBACK)).toBe(
      BIND_FALLBACK
    );
    expect(publicOrigin(headers({ host: "[::]:3500" }), BIND_FALLBACK)).toBe(
      BIND_FALLBACK
    );
  });

  it("falls back when no header carries a host", () => {
    expect(publicOrigin(headers({}), BIND_FALLBACK)).toBe(BIND_FALLBACK);
  });
});
