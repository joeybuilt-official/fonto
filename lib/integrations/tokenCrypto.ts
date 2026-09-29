// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (media import) — symmetric encryption for third-party OAuth refresh
// tokens stored in the `integrations` table. Refresh tokens are long-lived
// bearer credentials for the user's Google Drive; they MUST never sit in the
// database in plaintext.
//
// This module now DELEGATES to `lib/crypto/secret-box.ts` — the single
// implementation of the scheme (AES-256-GCM, key = scrypt(AUTH_SECRET,
// "fonto-integrations-v1", 32), stored as `v1:<ivB64>:<tagB64>:<ctB64>`).
// The format is unchanged, so ciphertext written before the delegation still
// decrypts; there is exactly ONE copy of the algorithm to review.
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";

export { decryptSecret, encryptSecret };

/** Encrypt a plaintext refresh token. See `lib/crypto/secret-box.ts`. */
export function encryptToken(plaintext: string): string {
  return encryptSecret(plaintext);
}

/**
 * Decrypt a stored token back to the plaintext refresh token. Throws if the
 * format/version is malformed or the GCM auth tag fails (tamper / wrong key).
 */
export function decryptToken(stored: string): string {
  return decryptSecret(stored);
}
