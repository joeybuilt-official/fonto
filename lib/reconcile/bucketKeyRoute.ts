// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0059 — confirm-bucket / undo-bucket request normalisation. Prefer the new
// opaque `bucketKey`; accept the legacy `{evidenceSource, conflict}` pair from
// pre-deploy client bundles / older APKs and fold it into a `src:` key. The
// server's predicateForKey is the only thing that ever parses the key, so a
// malformed token simply yields no rows — but we still prefix-validate here so a
// bad request is a clean 400 rather than a silently empty apply.

import { srcBucketKey } from "@/lib/reconcile/bucketReview";

const KEY_PREFIX = /^(src|dir|time):/;

/** Returns a validated bucketKey, or null when the body carries neither form. */
export function resolveBucketKey(body: Record<string, unknown>): string | null {
  if (typeof body.bucketKey === "string" && KEY_PREFIX.test(body.bucketKey)) {
    return body.bucketKey;
  }
  // Legacy source-axis pair.
  if (typeof body.conflict === "boolean") {
    const src =
      body.evidenceSource === null
        ? null
        : typeof body.evidenceSource === "string"
          ? body.evidenceSource
          : undefined;
    if (src !== undefined) return srcBucketKey(src, body.conflict);
  }
  return null;
}
