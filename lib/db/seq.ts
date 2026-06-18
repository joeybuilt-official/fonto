// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.3 — per-workspace monotonic sequence allocator for delta sync.
//
// Each syncable entity table (`assets`, `tags`, `collections`) carries a
// `seq bigint` column. Clients reading the sync feed pass back the highest
// seq they've seen, and the server returns rows with `seq > cursor`. To
// keep that ordering coherent we need a counter that is monotonic _per
// workspace_ — Postgres sequences are global, and creating one per
// workspace is awkward, so we use a tiny `workspace_seq` table with one
// row per workspace and one column per entity kind.
//
// `nextSeq()` is an atomic upsert: INSERT-or-UPDATE in a single statement,
// returning the post-increment value. Concurrent callers each get distinct
// values thanks to the row lock UPDATE takes — no extra serialization
// needed.
//
// Callers must invoke `nextSeq()` inside the same logical write that
// mutates the entity row (ideally the same transaction). The
// `withSeq*` helpers below do this in one shot for the common case.

import { sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export type SeqKind = "asset" | "tag" | "collection" | "project";

const COLUMN_BY_KIND: Record<SeqKind, "asset_seq" | "tag_seq" | "collection_seq" | "project_seq"> = {
  asset: "asset_seq",
  tag: "tag_seq",
  collection: "collection_seq",
  project: "project_seq",
};

/**
 * Allocate the next per-workspace seq for `kind`. Atomic; safe under
 * concurrency. Creates the workspace_seq row lazily on first use.
 *
 * Returns a bigint. Callers should write it directly into the entity row's
 * `seq` column in the same write that creates/updates that row.
 */
export async function nextSeq(workspaceId: string, kind: SeqKind): Promise<bigint> {
  const column = COLUMN_BY_KIND[kind];
  // INSERT a fresh row with this column at 1 (others default to 0); on
  // conflict, bump just this column and return the new value. The
  // sql.raw() interpolation is safe because `column` comes from a fixed
  // enum, not user input.
  const rows = (await db.execute(sql`
    INSERT INTO fonto.workspace_seq (workspace_id, ${sql.raw(column)})
    VALUES (${workspaceId}, 1)
    ON CONFLICT (workspace_id) DO UPDATE
      SET ${sql.raw(column)} = fonto.workspace_seq.${sql.raw(column)} + 1
    RETURNING ${sql.raw(column)} AS seq
  `)) as unknown as Array<{ seq: string | number | bigint }>;

  const raw = rows[0]?.seq;
  if (raw == null) {
    throw new Error(`nextSeq: no row returned for workspace=${workspaceId} kind=${kind}`);
  }
  return typeof raw === "bigint" ? raw : BigInt(raw as string | number);
}

/**
 * Convenience: bump the seq for an existing entity row (e.g. after a
 * lifecycle mutation, tag rename, etc.). The mutation itself is the
 * caller's job — this just stamps the row with a fresh seq.
 *
 * Returns the new seq so callers can include it in their response.
 */
export async function bumpAssetSeq(workspaceId: string, assetId: string): Promise<bigint> {
  const seq = await nextSeq(workspaceId, "asset");
  await db
    .update(schema.assets)
    .set({ seq, updatedAt: new Date() })
    .where(sql`${schema.assets.id} = ${assetId}`);
  return seq;
}

export async function bumpTagSeq(workspaceId: string, tagId: string): Promise<bigint> {
  const seq = await nextSeq(workspaceId, "tag");
  await db.update(schema.tags).set({ seq }).where(sql`${schema.tags.id} = ${tagId}`);
  return seq;
}

export async function bumpCollectionSeq(
  workspaceId: string,
  collectionId: string
): Promise<bigint> {
  const seq = await nextSeq(workspaceId, "collection");
  await db
    .update(schema.collections)
    .set({ seq, updatedAt: new Date() })
    .where(sql`${schema.collections.id} = ${collectionId}`);
  return seq;
}

export async function bumpProjectSeq(
  workspaceId: string,
  projectId: string
): Promise<bigint> {
  const seq = await nextSeq(workspaceId, "project");
  await db
    .update(schema.projects)
    .set({ seq, updatedAt: new Date() })
    .where(sql`${schema.projects.id} = ${projectId}`);
  return seq;
}
