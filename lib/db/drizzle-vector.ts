// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// pgvector column helper for Drizzle (ADR 0002, Phase 4.3).
//
// Drizzle has no first-class `vector` type, so we declare one via
// `customType`. Reuse this helper for every dense-vector column we add
// (clip_vec on assets in 0017; future face/arcface embeddings in Phase 5
// will use the same shape).
//
// On the wire pgvector accepts a literal of the form `[1,2,3]` and returns
// the same shape as text. We marshal between JS `number[]` and that text
// representation. JSON.parse is safe to use on the return path because the
// canonical pgvector text format is valid JSON.

import { customType } from "drizzle-orm/pg-core";

/**
 * Declare a `vector(<dim>)` column. The JS-side type is `number[]`; the
 * driver-side wire format is the pgvector text literal (`[1,2,3]`).
 *
 * @example
 *   clipVec: vector("clip_vec", 512),
 */
export const vector = (name: string, dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    fromDriver(v: unknown): number[] {
      if (Array.isArray(v)) return v as number[];
      if (typeof v === "string") return JSON.parse(v) as number[];
      throw new Error(
        `pgvector: unexpected driver representation ${typeof v}`
      );
    },
    toDriver(v: number[]): string {
      return `[${v.join(",")}]`;
    },
  })(name);

/**
 * Declare a native Postgres `bit(<n>)` column for a compact binary
 * fingerprint. Used for the 64-bit perceptual hash (`assets.phash_bits`),
 * which we query with pgvector's Hamming-distance operator (`<~>`) backed by a
 * `bit_hamming_ops` HNSW index — the indexed, bounded near-duplicate lookup
 * that replaced the workspace-wide `bit_count` scan (migration 0059).
 *
 * JS-side type is `bigint` (the unsigned fingerprint value); the driver
 * representation is an `n`-char string of '0'/'1'. `toDriver` masks to the low
 * `n` bits and left-pads so ORM inserts match Postgres' own `int8::bit(n)`
 * cast (used to backfill the column from the legacy signed `phash`).
 *
 * @example
 *   phashBits: bit("phash_bits", 64),
 */
export const bit = (name: string, n: number) =>
  customType<{ data: bigint; driverData: string }>({
    dataType() {
      return `bit(${n})`;
    },
    fromDriver(v: unknown): bigint {
      if (typeof v === "string") return BigInt(`0b${v}`);
      throw new Error(`bit(${n}): unexpected driver representation ${typeof v}`);
    },
    toDriver(v: bigint): string {
      const mask = (1n << BigInt(n)) - 1n;
      return (v & mask).toString(2).padStart(n, "0");
    },
  })(name);
