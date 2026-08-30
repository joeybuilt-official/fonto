// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// The asset pipeline's state vocabulary, owned in one place so the writers
// (processAsset / reapStuckAssets / the worker), the published contract
// (lib/openapi) and the `?processingState=` filter on GET /api/v1/assets
// cannot drift apart.
//
// Happy path: captured -> classified -> extracted -> ready. Terminal failure:
// failed. `processing` is a LEGACY literal the current pipeline never writes
// (see lib/processing/reapStuckAssets.ts); older rows still carry it and it
// means in-flight, so it stays accepted.
//
// `assets.processing_state` is an unconstrained text column, so this list is
// the documented set, not a database constraint — code that buckets rows for
// counting should still prefer a complement (see /api/v1/stats) over an
// enumeration.

export const PROCESSING_STATES = [
  "captured",
  "classified",
  "extracted",
  "ready",
  "failed",
  "processing",
] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

export function isProcessingState(v: unknown): v is ProcessingState {
  return typeof v === "string" && (PROCESSING_STATES as readonly string[]).includes(v);
}
