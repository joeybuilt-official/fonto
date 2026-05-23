// SPDX-License-Identifier: AGPL-3.0-only
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
