// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Storage placement policy types + effective-policy resolution. The DB is the
// source of truth: a workspace has a default `storage_policy`, an asset may pin
// a `storage_policy_override`. Effective policy = override ?? workspace policy.
//
// Operator decisions (ADR 0001): C4 ships r2_only + mirror first; local_only is
// a later phase. The type includes local_only for forward-compat, but no write
// path produces it yet.

export type StoragePolicy = "r2_only" | "mirror" | "local_only";

export const STORAGE_POLICIES: readonly StoragePolicy[] = [
  "r2_only",
  "mirror",
  "local_only",
] as const;

export function isStoragePolicy(v: unknown): v is StoragePolicy {
  return typeof v === "string" && (STORAGE_POLICIES as readonly string[]).includes(v);
}

/**
 * Resolve the effective policy for an asset: the per-asset override if set,
 * else the workspace default. Unknown/NULL inputs fall back to r2_only (today's
 * behavior) so a malformed row never silently localizes or drops cloud copies.
 */
export function effectiveStoragePolicy(args: {
  workspacePolicy: string | null | undefined;
  assetOverride?: string | null | undefined;
}): StoragePolicy {
  if (isStoragePolicy(args.assetOverride)) return args.assetOverride;
  if (isStoragePolicy(args.workspacePolicy)) return args.workspacePolicy;
  return "r2_only";
}

/** Whether an effective policy keeps a verified local copy of the original. */
export function policyKeepsLocalOriginal(p: StoragePolicy): boolean {
  return p === "mirror" || p === "local_only";
}

/** Whether an effective policy keeps the original in R2. */
export function policyKeepsR2Original(p: StoragePolicy): boolean {
  return p === "r2_only" || p === "mirror";
}
