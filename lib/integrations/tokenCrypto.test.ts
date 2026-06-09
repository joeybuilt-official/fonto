// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — unit tests for the refresh-token crypto helper.
//
// Two invariants matter:
//   1. Round-trip: decrypt(encrypt(x)) === x for assorted inputs.
//   2. Tamper detection: any mutation of the stored blob (or a wrong key)
//      fails the GCM auth tag and throws on decrypt — never returns garbage.
//
// AUTH_SECRET is set before importing the module under test (the key is read
// lazily on first encrypt/decrypt, so setting it here is sufficient).

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-tokenCrypto-unit-tests";
});

describe("tokenCrypto", () => {
  it("round-trips a typical refresh token", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto");
    const plain = "1//0gabcDEF_refresh-token.example-value-1234567890";
    const enc = encryptToken(plain);
    expect(decryptToken(enc)).toBe(plain);
  });

  it("round-trips assorted inputs (empty, unicode, long)", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto");
    const inputs = [
      "",
      "a",
      "résumé — 日本語 — 🔐",
      "x".repeat(4096),
    ];
    for (const plain of inputs) {
      expect(decryptToken(encryptToken(plain))).toBe(plain);
    }
  });

  it("emits the versioned v1:<ivB64>:<tagB64>:<ctB64> format", async () => {
    const { encryptToken } = await import("./tokenCrypto");
    const enc = encryptToken("token");
    const parts = enc.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  it("produces a distinct ciphertext each call (random IV)", async () => {
    const { encryptToken } = await import("./tokenCrypto");
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects a malformed blob", async () => {
    const { decryptToken } = await import("./tokenCrypto");
    expect(() => decryptToken("not-a-valid-blob")).toThrow();
    expect(() => decryptToken("v2:a:b:c")).toThrow();
  });

  it("detects tampering with the ciphertext", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto");
    const enc = encryptToken("super-secret");
    const [v, iv, tag, ct] = enc.split(":");
    // Flip the first base64 char of the ciphertext to a different valid char.
    const flipped = ct[0] === "A" ? "B" : "A";
    const tampered = `${v}:${iv}:${tag}:${flipped}${ct.slice(1)}`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("detects tampering with the auth tag", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto");
    const enc = encryptToken("super-secret");
    const [v, iv, tag, ct] = enc.split(":");
    const flipped = tag[0] === "A" ? "B" : "A";
    const tampered = `${v}:${iv}:${flipped}${tag.slice(1)}:${ct}`;
    expect(() => decryptToken(tampered)).toThrow();
  });
});
