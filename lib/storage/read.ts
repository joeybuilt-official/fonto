// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase B4 (storage placement) — original-byte READ with reconcile fallback.
//
// Per ADR 0001 C1, `mirror` workspaces serve reads by presigning from R2
// (edge-cached, fast); the local copy is a cold backup. The hot read paths
// (`assets/[id]/url`, `assets/urls`, HLS) therefore stay R2-direct and are
// unchanged by this phase. This module is the ONE place that reads the local
// backup: when an R2 original is unexpectedly missing (deleted / lost) but the
// asset has a verified local mirror, stream the original from local instead of
// failing. The reconcile sweep (Phase B5) uses this to detect + repair R2↔local
// divergence; it deliberately never sits on the per-request presign path.
//
// C2: derivatives (thumb/preview/HLS) are R2-only and never localized, so this
// only ever falls back for ORIGINAL keys.

import { logger } from "@/lib/logger";
import { r2, localFs } from "@/lib/storage";
import type { GetOptions, StreamResult } from "./interface";

/**
 * True for an S3/R2 "object does not exist" error. The AWS SDK v3 surfaces a
 * missing key as a `NoSuchKey` (GetObject) or `NotFound` (HeadObject) named
 * error, or — depending on transport — a generic error carrying a 404 in
 * `$metadata`. Only a genuine miss should trigger a local fallback; auth /
 * network / range errors must propagate so they aren't masked as "missing".
 */
export function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return status === 404;
}

export interface OriginalReadResult extends StreamResult {
  /** Which backend actually served the bytes. */
  source: "r2" | "local";
}

/**
 * Stream an asset's ORIGINAL, preferring R2 (the C1 hot path). If R2 reports the
 * object missing AND the asset has a verified local mirror
 * (`assets.local_original_stored_at` set → `hasLocalOriginal`), stream from
 * local instead so a mirrored library survives an R2-side loss. Any other R2
 * error is rethrown unchanged — only a true miss falls back. When R2 is missing
 * and no usable local copy exists, the original R2 error propagates.
 */
export async function readOriginalStream(
  args: { key: string; hasLocalOriginal: boolean },
  opts?: GetOptions
): Promise<OriginalReadResult> {
  try {
    const s = await r2().getStream(args.key, opts);
    return { ...s, source: "r2" };
  } catch (err) {
    if (!isMissingObjectError(err)) throw err;
    if (!args.hasLocalOriginal || !process.env.LOCAL_STORAGE_ROOT) throw err;
    logger
      .child({ component: "storage-read", key: args.key })
      .warn("R2 original missing — serving from local mirror (divergence)");
    const s = await localFs().getStream(args.key, opts);
    return { ...s, source: "local" };
  }
}
