// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — symmetric encryption for third-party OAuth refresh
// tokens stored in the `integrations` table. Refresh tokens are long-lived
// bearer credentials for the user's Google Drive; they MUST never sit in the
// database in plaintext.
//
// Scheme: AES-256-GCM.
//   - Key: 32 bytes derived from `process.env.AUTH_SECRET` via
//     `scryptSync(AUTH_SECRET, 'fonto-integrations-v1', 32)`. We reuse the
//     Better Auth secret (already required at boot — see `lib/auth.ts`) rather
//     than introducing a new secret to provision; the static salt namespaces
//     the derived key so it never collides with any other AUTH_SECRET use.
//   - Per-message random 12-byte IV (GCM nonce).
//   - 16-byte GCM auth tag (authenticated encryption — tampering is detected
//     on decrypt and throws).
//   - Stored format: `v1:<ivB64>:<tagB64>:<ctB64>` (a version tag plus three
//     base64-encoded fields). The explicit `v1` prefix is forward-compatible:
//     a future key rotation / scheme change bumps the version, and `decrypt`
//     can branch on it without ambiguity.
//
// Pure, side-effect-free functions (modulo reading AUTH_SECRET) so they are
// unit-testable without a database or network.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length.
const KEY_BYTES = 32; // AES-256.
const KEY_SALT = "fonto-integrations-v1";
const VERSION = "v1"; // Stored-format version prefix.

/**
 * Derive the 32-byte AES key from AUTH_SECRET. Computed lazily (not at module
 * load) so importing this file never throws in contexts where AUTH_SECRET is
 * absent (e.g. type-checking, tree-shaken builds). Cached after first use.
 */
let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set — cannot derive integrations encryption key"
    );
  }
  cachedKey = scryptSync(secret, KEY_SALT, KEY_BYTES);
  return cachedKey;
}

/**
 * Encrypt a plaintext refresh token. Returns `v1:<ivB64>:<tagB64>:<ctB64>`.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypt a stored `v1:<ivB64>:<tagB64>:<ctB64>` blob back to the plaintext
 * refresh token. Throws if the format/version is malformed or the GCM auth tag
 * fails (tamper / wrong key).
 */
export function decryptToken(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      "Malformed encrypted token: expected v1:<ivB64>:<tagB64>:<ctB64>"
    );
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
