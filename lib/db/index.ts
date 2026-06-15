// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | null = null;

function getDb(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is not set");
    // T1.6 (perf audit 2026-06-15): cap the pool. postgres-js defaults to an
    // unbounded pool, which under spike load (e.g. 3 worker replicas + Next
    // server all hammering pushd) lets connections balloon past pushd's own
    // limits. 20 is well under the postgres ceiling (per the
    // Better-auth pool which is already max:10), still ample for steady
    // traffic. Override via FONTO_PG_POOL_MAX if needed.
    const max = Math.max(1, Number(process.env.FONTO_PG_POOL_MAX) || 20);
    const client = postgres(url, { prepare: false, max });
    _db = drizzle(client, { schema });
  }
  return _db;
}

export const db = new Proxy({} as Db, {
  get(_, prop: string | symbol) {
    return getDb()[prop as keyof Db];
  },
});

export { schema };
