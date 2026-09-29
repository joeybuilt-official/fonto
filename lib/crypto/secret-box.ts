// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// AES-256-GCM secret box — the ONE home for app-owned credentials at rest.
//
// Fonto stores two classes of secret: third-party OAuth refresh tokens
// (`integrations.encrypted_refresh_token`) and per-user AI connection API keys
// (`fonto.ai_connections.encrypted_api_key`). Both are encrypted here.
//
// Scheme (unchanged from the original `lib/integrations/tokenCrypto.ts`, so
// ciphertext written before this module existed still decrypts):
//   - Key: 32 bytes = scrypt(AUTH_SECRET, "fonto-integrations-v1", 32).
//     AUTH_SECRET is already required at boot (Better Auth), so there is no
//     second secret to provision.
//   - Per-message random 12-byte GCM nonce, 16-byte auth tag (tampering is
//     detected on decrypt and throws).
//   - Stored format: `v1:<ivB64>:<tagB64>:<ctB64>`.
//
// `lib/integrations/tokenCrypto.ts` delegates here so there is exactly ONE
// implementation of the scheme to review.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length.
const KEY_BYTES = 32; // AES-256.
const KEY_SALT = "fonto-integrations-v1";
const VERSION = "v1";

/**
 * Derive the 32-byte AES key from AUTH_SECRET. Computed lazily (not at module
 * load) so importing this file never throws in contexts where AUTH_SECRET is
 * absent (type-checking, tree-shaken builds). Cached after first use.
 */
let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — cannot derive the secret-box key");
  }
  cachedKey = scryptSync(secret, KEY_SALT, KEY_BYTES);
  return cachedKey;
}

/** Encrypt a plaintext secret. Returns `v1:<ivB64>:<tagB64>:<ctB64>`. */
export function encryptSecret(plaintext: string): string {
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
 * Decrypt a stored `v1:<ivB64>:<tagB64>:<ctB64>` blob. Throws if the
 * format/version is malformed or the GCM auth tag fails (tamper / wrong key).
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      "Malformed encrypted secret: expected v1:<ivB64>:<tagB64>:<ctB64>"
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

/** Last four characters of a decrypted secret, for masked display. Never throws. */
export function secretLast4(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const plain = decryptSecret(payload);
    return plain ? plain.slice(-4) : null;
  } catch {
    return null;
  }
}
