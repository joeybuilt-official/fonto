// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { sql, type SQL } from "drizzle-orm";

/**
 * Bind a JS array as a Postgres array literal inside a `drizzle-orm` `sql`
 * template.
 *
 * Why: in a `sql` template, `${jsArray}` is expanded as a parameter tuple
 * `($1, $2, …)`. That looks identical to a row constructor to Postgres, so
 * `${jsArray}::text[]` becomes `($1,$2)::text[]` and the planner rejects it
 * with `cannot cast type record to text[]` (SQLSTATE 42846). Wrap with
 * `pgArray(arr)` to emit `ARRAY[$1, $2, …]` instead, which casts cleanly.
 *
 * @example
 *   // BAD — `${ids}::uuid[]` casts a record, not an array.
 *   sql`WHERE id = ANY(${ids}::uuid[])`
 *   // GOOD
 *   sql`WHERE id = ANY(${pgArray(ids)}::uuid[])`
 */
export function pgArray<T>(values: readonly T[]): SQL {
  if (values.length === 0) return sql`ARRAY[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )}]`;
}
