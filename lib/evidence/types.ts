// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3 (ADR-0002/0003). Shared types for the evidence
// extractors. An adapter turns one signal source (faces, scene labels, OCR
// text, EXIF, …) into zero or more `EvidenceInput`s, which the orchestrator
// writes to `fonto.image_date_evidence`.
//
// An adapter NEVER computes the per-evidence likelihood vector — that is the
// fusion contract (ADR-0003), owned by the Phase 4 engine, which reads
// `sourceDetail`. Phase 3 only extracts the structured signal + stamps
// provenance. This keeps the extractors I/O-shaped and the fusion math pure.

export type EvidenceType =
  | "identity_bound"
  | "apparent_age"
  | "trip_match"
  | "scene_season"
  | "ocr_date"
  | "exif"
  | "filename"
  | "fs_mtime"
  | "cluster_propagation"
  | "co_occurrence";

export interface EvidenceInput {
  evidenceType: EvidenceType;
  /**
   * The structured raw signal this adapter extracted. Shape is per
   * evidence_type — the Phase 4 likelihood fns dispatch on `evidenceType` and
   * read the fields they expect. Must be JSON-serialisable.
   */
  sourceDetail: Record<string, unknown>;
  /**
   * Producing model/rule version. A bump re-extracts ONLY this evidence_type's
   * rows for affected assets (ADR-0006). Perception-backed types carry the Plexo
   * model id; Fonto-local rules carry a rule-version string ("exif@1").
   */
  modelVersion: string;
}
