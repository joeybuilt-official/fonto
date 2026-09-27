// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Pins the SHARE_LINK_IP_SALT privacy contract.
//
// The property under test: a share-link access row stores
// `sha256(SHARE_LINK_IP_SALT + ip)` and NEVER the raw IP. That only holds if the
// salt is per-deploy random. The dev fallback salt is a constant that is public
// in this repository, so in production an unset salt must be a hard error rather
// than a silent downgrade — otherwise every ipHash in the database is
// recomputable by anyone who can read this source.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashIp } from "./ip-hash";

const DEV_FALLBACK_SALT = "DEV_INSECURE_SALT_DO_NOT_USE_IN_PROD";

// `process.env.NODE_ENV` is declared readonly in @types/node, and its `delete`
// is rejected outright (TS2704). Tests legitimately need to flip it to prove
// the production throw, so go through one mutable view instead of sprinkling
// casts through the assertions.
type MutableEnv = Record<string, string | undefined>;
const mutableEnv = process.env as unknown as MutableEnv;

describe("hashIp / SHARE_LINK_IP_SALT", () => {
  const originalSalt = process.env.SHARE_LINK_IP_SALT;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.SHARE_LINK_IP_SALT;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalSalt === undefined) delete process.env.SHARE_LINK_IP_SALT;
    else process.env.SHARE_LINK_IP_SALT = originalSalt;
    if (originalEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  it("hashes with the configured salt, not the constant", () => {
    process.env.SHARE_LINK_IP_SALT = "a-real-random-salt";
    const h = hashIp("203.0.113.7");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Not the raw IP, and not a hash of the constant fallback.
    expect(h).not.toContain("203.0.113.7");
    process.env.SHARE_LINK_IP_SALT = DEV_FALLBACK_SALT;
    expect(hashIp("203.0.113.7")).not.toBe(h);
  });

  it("is stable for one salt and differs across salts", () => {
    process.env.SHARE_LINK_IP_SALT = "salt-one";
    const a = hashIp("203.0.113.7");
    expect(hashIp("203.0.113.7")).toBe(a);
    process.env.SHARE_LINK_IP_SALT = "salt-two";
    expect(hashIp("203.0.113.7")).not.toBe(a);
  });

  it("THROWS in production when the salt is unset (never degrades silently)", () => {
    mutableEnv.NODE_ENV = "production";
    expect(() => hashIp("203.0.113.7")).toThrowError(/SHARE_LINK_IP_SALT is not set/);
  });

  it("still works in development with the constant, but warns loudly", () => {
    mutableEnv.NODE_ENV = "development";
    const h = hashIp("203.0.113.7");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("SHARE_LINK_IP_SALT is unset")
    );
  });

  it("never emits the raw client IP", () => {
    process.env.SHARE_LINK_IP_SALT = "a-real-random-salt";
    const ip = "203.0.113.42";
    expect(hashIp(ip)).not.toContain(ip);
    expect(hashIp(ip)).not.toContain("203.0.113");
  });
});
