// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Tests for the secret box — the single home for credential encryption.
//
// Covers the contract that matters operationally:
//   - round-trip correctness;
//   - tamper detection (GCM auth tag);
//   - format stability (v1:<iv>:<tag>:<ct> — ciphertext written by the old
//     tokenCrypto implementation must still decrypt, which is why the format
//     is asserted literally rather than only round-tripped);
//   - masked last-4 never throws on garbage;
//   - a missing AUTH_SECRET fails loudly instead of writing plaintext.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  secretLast4,
} from "@/lib/crypto/secret-box";

const ORIG = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-secret-box";
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIG;
});

describe("secret-box", () => {
  it("round-trips a secret", () => {
    const plain = "sk-test-abcdef123456";
    const ct = encryptSecret(plain);
    expect(decryptSecret(ct)).toBe(plain);
  });

  it("produces the documented v1:<iv>:<tag>:<ct> format", () => {
    const ct = encryptSecret("hello world");
    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // 12-byte IV and 16-byte tag in base64.
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it("uses a fresh IV per encryption (no deterministic ciphertext)", () => {
    const a = encryptSecret("same input");
    const b = encryptSecret("same input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const ct = encryptSecret("sensitive");
    const parts = ct.split(":");
    // Flip a byte in the ciphertext payload.
    const raw = Buffer.from(parts[3], "base64");
    raw[0] = raw[0] ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], raw.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-a-ciphertext")).toThrow(/Malformed/);
    expect(() => decryptSecret("v2:a:b:c")).toThrow(/Malformed/);
  });

  it("secretLast4 returns the masked tail and never throws", () => {
    expect(secretLast4(encryptSecret("sk-abcdef1234"))).toBe("1234");
    expect(secretLast4(null)).toBeNull();
    expect(secretLast4(undefined)).toBeNull();
    expect(secretLast4("garbage")).toBeNull();
  });

  it("throws when AUTH_SECRET is absent rather than writing plaintext", async () => {
    // The module caches the derived key after first use, so exercise the
    // missing-secret path in a FRESH module instance.
    delete process.env.AUTH_SECRET;
    vi.resetModules();
    const fresh = await import("@/lib/crypto/secret-box");
    expect(() => fresh.encryptSecret("x")).toThrow(/AUTH_SECRET/);
  });
});
