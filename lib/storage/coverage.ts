// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B5 (storage placement) — per-workspace mirror-coverage stat. Surfaced
// in Settings → Storage (Phase B6 UX). Per ADR 0001 C3: the logical library is
// counted once for quota (usageBytes is untouched by mirroring); the local-disk
// figure here is a SEPARATE budget (`localBytes`) so the operator sees NAS disk
// consumption distinct from their quota.

import { and, eq, isNull, isNotNull, inArray, or, count, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { effectiveStoragePolicy, policyKeepsLocalOriginal, type StoragePolicy } from "./policy";

const LOCAL_POLICIES = ["mirror", "local_only"] as const;

export interface MirrorCoverage {
  /** Effective workspace-default policy. */
  policy: StoragePolicy;
  /** Active assets whose effective policy keeps a local original. */
  eligible: number;
  /** Of the eligible, how many have a verified local copy (stamp set). */
  mirrored: number;
  /** Bytes currently on the local backend — the separate NAS-disk figure (C3). */
  localBytes: number;
}

/**
 * Count mirror coverage for a workspace. Eligibility honors the per-asset
 * override: an asset overridden onto `r2_only` in a `mirror` workspace is NOT
 * eligible, and an asset overridden onto `mirror` in an `r2_only` workspace IS.
 */
export async function mirrorCoverage(workspaceId: string): Promise<MirrorCoverage> {
  const [ws] = await db
    .select({ policy: schema.workspaces.storagePolicy })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const policy = effectiveStoragePolicy({ workspacePolicy: ws?.policy });

  const active = eq(schema.assets.lifecycleState, "active");
  const inWs = eq(schema.assets.workspaceId, workspaceId);
  const overrideLocal = inArray(schema.assets.storagePolicyOverride, [...LOCAL_POLICIES]);

  // Effective-policy-keeps-local, expressed in SQL so we never page 10k rows.
  const eligibleCond = policyKeepsLocalOriginal(policy)
    ? and(active, inWs, or(isNull(schema.assets.storagePolicyOverride), overrideLocal))
    : and(active, inWs, overrideLocal);

  const [eligibleRow] = await db
    .select({ value: count() })
    .from(schema.assets)
    .where(eligibleCond);

  const [mirroredRow] = await db
    .select({ value: count() })
    .from(schema.assets)
    .where(and(eligibleCond, isNotNull(schema.assets.localOriginalStoredAt)));

  // localBytes counts every asset that currently holds a local original,
  // regardless of present eligibility (a policy flip leaves real bytes on disk
  // until a future delete reclaims them — the operator should see them).
  const [bytesRow] = await db
    .select({ value: sql<string>`coalesce(sum(${schema.assets.sizeBytes}), 0)` })
    .from(schema.assets)
    .where(and(active, inWs, isNotNull(schema.assets.localOriginalStoredAt)));

  return {
    policy,
    eligible: Number(eligibleRow?.value ?? 0),
    mirrored: Number(mirroredRow?.value ?? 0),
    localBytes: Number(bytesRow?.value ?? 0),
  };
}
