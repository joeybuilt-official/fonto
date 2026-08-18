// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — stacks: shared write paths used by the `/api/v1/stacks/*`
// route handlers and by `POST /api/v1/stacks/suggestions/accept`. Keeping
// the lifecycle logic here (rather than duplicating across handlers) means
// the "what does primary mean" rule lives in exactly one place.

import { db, schema } from "@/lib/db";
import { and, eq, inArray, asc } from "drizzle-orm";
import { loadAssetsForStack } from "./suggest";

export interface CreateStackInput {
  workspaceId: string;
  assetIds: string[];
  primaryAssetId: string;
  name?: string | null;
}

export type CreateStackError =
  | { kind: "no-assets" }
  | { kind: "primary-not-in-set" }
  | { kind: "missing-or-foreign" }
  | { kind: "already-stacked"; assetId: string };

export type CreateStackResult =
  | { ok: true; stack: typeof schema.stacks.$inferSelect; assetIds: string[] }
  | { ok: false; error: CreateStackError };

/**
 * Create a new stack and attach every listed asset to it. Validates that:
 *   - `assetIds` is non-empty
 *   - `primaryAssetId` is in `assetIds`
 *   - all assets exist and belong to `workspaceId`
 *   - none of them already belong to another stack
 *
 * Writes are sequential — Drizzle exposes `db.transaction` but we keep the
 * happy path simple here; the per-asset update is idempotent enough that
 * the partial-failure cleanup story is "the next call sees a half-stacked
 * group" which the user can fix by re-creating. No correctness invariant
 * is violated.
 */
export async function createStack(input: CreateStackInput): Promise<CreateStackResult> {
  if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) {
    return { ok: false, error: { kind: "no-assets" } };
  }
  if (!input.assetIds.includes(input.primaryAssetId)) {
    return { ok: false, error: { kind: "primary-not-in-set" } };
  }

  const assets = await loadAssetsForStack(input.workspaceId, input.assetIds);
  if (!assets) return { ok: false, error: { kind: "missing-or-foreign" } };

  const alreadyStacked = assets.find((a) => a.stackId !== null);
  if (alreadyStacked) {
    return { ok: false, error: { kind: "already-stacked", assetId: alreadyStacked.id } };
  }

  const [stack] = await db
    .insert(schema.stacks)
    .values({
      workspaceId: input.workspaceId,
      primaryAssetId: input.primaryAssetId,
      name: input.name ?? null,
    })
    .returning();

  await db
    .update(schema.assets)
    .set({ stackId: stack.id })
    .where(inArray(schema.assets.id, input.assetIds));

  return { ok: true, stack, assetIds: input.assetIds };
}

/**
 * Sort members of a stack: primary first, then by ascending capturedAt
 * (falling back to createdAt for assets that have no EXIF date).
 */
export function sortStackMembers<
  T extends {
    id: string;
    capturedAt: Date | null;
    createdAt: Date;
  }
>(members: T[], primaryAssetId: string): T[] {
  const primary = members.find((m) => m.id === primaryAssetId);
  const rest = members
    .filter((m) => m.id !== primaryAssetId)
    .sort((a, b) => {
      const at = (a.capturedAt ?? a.createdAt).getTime();
      const bt = (b.capturedAt ?? b.createdAt).getTime();
      return at - bt;
    });
  return primary ? [primary, ...rest] : rest;
}

/**
 * After removing one asset from a stack, ensure the stack's invariants
 * still hold: either promote the next-oldest member to primary if the
 * removed asset WAS the primary, or delete the stack entirely if empty.
 *
 * The caller is responsible for already having set `stack_id = NULL` on
 * the removed asset before invoking this. Pass the stack's *new* member
 * set (post-removal). `removedAssetId` is just the id that was removed —
 * we use it solely to decide whether a primary swap is needed.
 */
export async function reconcileStackAfterRemoval(
  stack: typeof schema.stacks.$inferSelect,
  remainingMembers: typeof schema.assets.$inferSelect[],
  removedAssetId: string
): Promise<{ deleted: boolean; newPrimaryAssetId: string | null }> {
  if (remainingMembers.length === 0) {
    await db.delete(schema.stacks).where(eq(schema.stacks.id, stack.id));
    return { deleted: true, newPrimaryAssetId: null };
  }

  if (stack.primaryAssetId !== removedAssetId) {
    // Primary still present — nothing to do.
    return { deleted: false, newPrimaryAssetId: stack.primaryAssetId };
  }

  // Pick next-oldest by capturedAt (fallback createdAt).
  const sorted = [...remainingMembers].sort((a, b) => {
    const at = (a.capturedAt ?? a.createdAt).getTime();
    const bt = (b.capturedAt ?? b.createdAt).getTime();
    return at - bt;
  });
  const newPrimary = sorted[0];

  await db
    .update(schema.stacks)
    .set({ primaryAssetId: newPrimary.id, updatedAt: new Date() })
    .where(eq(schema.stacks.id, stack.id));

  return { deleted: false, newPrimaryAssetId: newPrimary.id };
}

/**
 * Look up a stack by id, scoped to a set of workspaces. Returns null if
 * the stack is in a workspace the caller can't access.
 */
export async function findStackInWorkspaces(
  stackId: string,
  workspaceIds: string[]
): Promise<typeof schema.stacks.$inferSelect | null> {
  if (workspaceIds.length === 0) return null;
  const [row] = await db
    .select()
    .from(schema.stacks)
    .where(
      and(
        eq(schema.stacks.id, stackId),
        inArray(schema.stacks.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Return the asset rows that belong to a stack, sorted primary-first.
 */
export async function loadStackMembers(
  stack: typeof schema.stacks.$inferSelect
): Promise<typeof schema.assets.$inferSelect[]> {
  const rows = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.workspaceId, stack.workspaceId),
        eq(schema.assets.stackId, stack.id)
      )
    )
    .orderBy(asc(schema.assets.capturedAt));
  return sortStackMembers(rows, stack.primaryAssetId);
}
