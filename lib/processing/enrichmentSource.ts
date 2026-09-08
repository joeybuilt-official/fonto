// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Which enrichment tier produced a row's classification / description / OCR.
 *
 * Owning module for the `assets.enrichment_source` vocabulary (migration 0061)
 * so producer and consumer cannot drift. NULL in the column stays meaningful
 * and distinct from every value here: "pre-plan / unknown". Historical rows are
 * never backfilled — inventing a provenance is the exact fiction this column
 * exists to prevent.
 */
export const EnrichmentSource = {
  /** One multimodal analyze-image call answered classification + description + OCR. */
  UnifiedVlm: "unified-vlm",
  /** No generative tier was reachable; the answer is a CLIP argmax over the taxonomy. */
  ClipArgmax: "clip-argmax",
  /** CLIP vector was not ready in time; the row is queued for a later pass. */
  ClipPending: "clip-pending",
  /** Enriched on demand by a VLM at read time rather than on the ingest path. */
  LazyVlm: "lazy-vlm",
} as const;

export type EnrichmentSource = (typeof EnrichmentSource)[keyof typeof EnrichmentSource];
