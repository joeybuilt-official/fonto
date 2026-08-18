// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Memory port — pgvector-backed embedded-tier adapter (ADR-002 §Memory).

import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  Memory,
  CapabilityUnavailableError,
  type MemoryRecord,
  type MemorySearchRequest,
  type MemorySearchResult,
} from "../ports";

export const PgvectorMemoryLayer = Layer.succeed(Memory, {
  store: (record: MemoryRecord) =>
    Effect.tryPromise({
      try: async () => {
        const vecStr = `[${record.vector.join(",")}]`;
        await db.execute(sql`
          INSERT INTO fonto.intelligence_memory (id, content, vector, metadata)
          VALUES (
            ${record.id}::uuid,
            ${record.content},
            ${vecStr}::vector,
            ${JSON.stringify(record.metadata ?? {})}::jsonb
          )
          ON CONFLICT (id) DO UPDATE
            SET content = EXCLUDED.content,
                vector = EXCLUDED.vector,
                metadata = EXCLUDED.metadata,
                updated_at = now()
        `);
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/Memory",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),

  search: (req: MemorySearchRequest) =>
    Effect.tryPromise({
      try: async () => {
        const vecStr = `[${req.queryVector.join(",")}]`;
        const topK = req.topK ?? 10;
        const threshold = req.threshold ?? 0.7;

        type Row = { id: string; content: string; vector: string; metadata: Record<string, unknown> | null; score: number };
        const rows = await db.execute(sql`
          SELECT
            id::text,
            content,
            vector::text,
            metadata,
            1 - (vector <=> ${vecStr}::vector) AS score
          FROM fonto.intelligence_memory
          WHERE 1 - (vector <=> ${vecStr}::vector) >= ${threshold}
          ORDER BY vector <=> ${vecStr}::vector
          LIMIT ${topK}
        `);

        return (rows as unknown as Row[]).map(
          (row): MemorySearchResult => ({
            record: {
              id: row.id,
              content: row.content,
              vector: row.vector
                ? row.vector.replace(/^\[|\]$/g, "").split(",").map(Number)
                : [],
              metadata: row.metadata ?? undefined,
            },
            score: row.score,
          })
        );
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/Memory",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),
});
