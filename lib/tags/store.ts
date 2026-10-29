// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M10 / ADR 0013 — the tag tree's persistence API.
//
// A route handler asks for a tag operation and maps the answer to HTTP; the
// depth, cycle and subtree invariants live HERE, beside the SQL that can break
// them. Before this module existed each rule had one copy inside a handler, so
// a second caller would have had to reproduce the cycle guard by hand and keep
// the two in agreement forever.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { nextSeq } from "@/lib/db/seq";
import { childPath, pathDepth, TAG_DEPTH_LIMIT } from "./tree";

export type TagRow = typeof schema.tags.$inferSelect;

export type TopTagRow = {
  id: string;
  name: string;
  color: string;
  aiSuggested: boolean;
  count: number;
  sampleAssetId: string | null;
};

/** A request the tag tree refuses. `code` is stable; the message is for logs. */
export type TagRuleCode =
  | "parent_not_found"
  | "max_depth"
  | "self_parent"
  | "cycle"
  | "move_exceeds_depth";

export class TagRuleError extends Error {
  constructor(
    readonly code: TagRuleCode,
    message: string
  ) {
    super(message);
    this.name = "TagRuleError";
  }
}

export async function listTags(workspaceIds: string[]): Promise<TagRow[]> {
  if (!workspaceIds.length) return [];
  return db.select().from(schema.tags).where(inArray(schema.tags.workspaceId, workspaceIds));
}

export async function findTag(workspaceId: string, tagId: string): Promise<TagRow | null> {
  const [tag] = await db
    .select()
    .from(schema.tags)
    .where(and(eq(schema.tags.id, tagId), eq(schema.tags.workspaceId, workspaceId)))
    .limit(1);
  return tag ?? null;
}

async function findParentPath(workspaceId: string, parentId: string): Promise<string> {
  const [parent] = await db
    .select({ id: schema.tags.id, path: schema.tags.path })
    .from(schema.tags)
    .where(and(eq(schema.tags.id, parentId), eq(schema.tags.workspaceId, workspaceId)))
    .limit(1);
  if (!parent) throw new TagRuleError("parent_not_found", "parent not found");
  return parent.path;
}

export type CreateTagInput = {
  name: string;
  color?: string;
  parentId?: string | null;
};

export async function createTag(workspaceId: string, input: CreateTagInput): Promise<TagRow> {
  let parentPath: string | null = null;
  if (input.parentId) {
    parentPath = await findParentPath(workspaceId, input.parentId);
    if (pathDepth(parentPath) >= TAG_DEPTH_LIMIT)
      throw new TagRuleError("max_depth", "max nesting depth reached");
  }

  const seq = await nextSeq(workspaceId, "tag");
  const [created] = await db
    .insert(schema.tags)
    .values({
      workspaceId,
      name: input.name.trim().toLowerCase(),
      color: input.color ?? "#6366f1",
      parentId: input.parentId ?? null,
      seq,
    })
    .returning();

  const [tag] = await db
    .update(schema.tags)
    .set({ path: childPath(parentPath, created.id) })
    .where(eq(schema.tags.id, created.id))
    .returning();
  return tag;
}

export type UpdateTagInput = {
  name?: string;
  color?: string;
  /** Present means "move this tag"; `null` moves it to the root. */
  parentId?: string | null;
  reparent: boolean;
};

export async function updateTag(
  workspaceId: string,
  tagId: string,
  input: UpdateTagInput
): Promise<TagRow | null> {
  const tag = await findTag(workspaceId, tagId);
  if (!tag) return null;

  const fields: { name?: string; color?: string } = {};
  if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim().toLowerCase();
  if (typeof input.color === "string") fields.color = input.color;

  const bumpSeq = () => nextSeq(workspaceId, "tag");

  if (!input.reparent) {
    const [updated] = await db
      .update(schema.tags)
      .set({ ...fields, seq: await bumpSeq() })
      .where(eq(schema.tags.id, tagId))
      .returning();
    return updated;
  }

  const newParentId = input.parentId ?? null;
  if (newParentId === tagId)
    throw new TagRuleError("self_parent", "a tag cannot be its own parent");

  let newParentPath: string | null = null;
  if (newParentId) {
    newParentPath = await findParentPath(workspaceId, newParentId);
    // The new parent must not be this tag or anything beneath it.
    if (newParentPath.startsWith(tag.path))
      throw new TagRuleError("cycle", "cannot move a tag under its own descendant");
  }

  const oldSelfPath = tag.path;
  const newSelfPath = childPath(newParentPath, tagId);
  if (newSelfPath === oldSelfPath) {
    const [updated] = await db
      .update(schema.tags)
      .set({ ...fields, seq: await bumpSeq() })
      .where(eq(schema.tags.id, tagId))
      .returning();
    return updated;
  }

  // The deepest descendant after the move must still fit the cap.
  const descendants = await db
    .select({ id: schema.tags.id, path: schema.tags.path })
    .from(schema.tags)
    .where(
      and(
        eq(schema.tags.workspaceId, workspaceId),
        sql`${schema.tags.path} LIKE ${oldSelfPath + "%"}`
      )
    );
  const oldSelfDepth = pathDepth(oldSelfPath);
  const subtreeHeight = descendants.reduce((m, d) => Math.max(m, pathDepth(d.path) - oldSelfDepth), 0);
  if (pathDepth(newSelfPath) + subtreeHeight > TAG_DEPTH_LIMIT)
    throw new TagRuleError("move_exceeds_depth", "move would exceed max nesting depth");

  await db.transaction(async (tx) => {
    // Rewrite every subtree row's path: newSelfPath || (path minus oldSelfPath).
    await tx
      .update(schema.tags)
      .set({
        path: sql`${newSelfPath} || substring(${schema.tags.path} from ${oldSelfPath.length + 1})`,
      })
      .where(
        and(
          eq(schema.tags.workspaceId, workspaceId),
          sql`${schema.tags.path} LIKE ${oldSelfPath + "%"}`
        )
      );
    await tx.update(schema.tags).set({ parentId: newParentId, ...fields }).where(eq(schema.tags.id, tagId));
    // Bump seq for every moved row so delta-sync clients pick up the new path.
    for (const d of descendants) {
      await tx.update(schema.tags).set({ seq: await bumpSeq() }).where(eq(schema.tags.id, d.id));
    }
  });

  return findTag(workspaceId, tagId);
}

/** Most-used tags across the caller's workspaces, with an active-asset count. */
export async function listTopTags(workspaceIds: string[], limit: number): Promise<TopTagRow[]> {
  if (!workspaceIds.length) return [];
  const countExpr = sql<number>`count(distinct ${schema.assetTags.assetId})::int`;
  return db
    .select({
      id: schema.tags.id,
      name: schema.tags.name,
      color: schema.tags.color,
      aiSuggested: schema.tags.aiSuggested,
      count: countExpr,
      sampleAssetId: sql<
        string | null
      >`(array_agg(${schema.assetTags.assetId} ORDER BY ${schema.assetTags.addedAt} DESC))[1]`,
    })
    .from(schema.tags)
    .innerJoin(schema.assetTags, eq(schema.assetTags.tagId, schema.tags.id))
    .innerJoin(schema.assets, eq(schema.assets.id, schema.assetTags.assetId))
    .where(
      and(inArray(schema.tags.workspaceId, workspaceIds), eq(schema.assets.lifecycleState, "active"))
    )
    .groupBy(schema.tags.id)
    .orderBy(desc(countExpr))
    .limit(limit);
}
