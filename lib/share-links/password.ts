// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// argon2id password hashing for share-link passwords.
//
// Parameters follow OWASP 2025 minimums for argon2id:
//   m = 64 MiB, t = 3 iterations, p = 1 parallelism.
// These knobs are intentionally tuned for *interactive* verification — a
// share-resolve request hashes a single attempt and waits ~50–80 ms on
// modern hardware. We do NOT mint these hashes in bulk, so paying memory
// here is acceptable and rules out off-the-shelf GPU cracking.

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

// @node-rs/argon2 exports `Algorithm` as a const enum, which can't be imported
// type-only under `isolatedModules`. Use the numeric value directly: argon2id = 2.
const ARGON2ID = 2 as const;

// 64 MiB. @node-rs takes memoryCost in KiB.
const MEMORY_COST_KIB = 64 * 1024;
const TIME_COST = 3;
const PARALLELISM = 1;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("hashPassword: empty password");
  return argonHash(plaintext, {
    algorithm: ARGON2ID,
    memoryCost: MEMORY_COST_KIB,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
  });
}

/**
 * Constant-time-ish verify. @node-rs/argon2 dispatches into native Rust which
 * uses argon2's own constant-time comparison internally — we don't need to
 * wrap with timingSafeEqual.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  if (!hash || !plaintext) return false;
  try {
    return await argonVerify(hash, plaintext);
  } catch {
    // Malformed hash, mismatched algorithm, etc. — treat as failed verify
    // rather than 500 so a corrupt row doesn't break the entire share route.
    return false;
  }
}
