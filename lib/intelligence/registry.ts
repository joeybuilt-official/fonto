// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Jex intelligence registry (ADR-003 §tier ranks).
// resolveIntelligenceLayer(): returns best available tier Layer.

import { Layer } from "effect";
import { PlexoFederatedLayer } from "./adapters/plexo-federated";
import { AnthropicCompletionLayer } from "./adapters/anthropic";
import {
  VisionSidecarImageEmbeddingLayer,
  VisionSidecarTextEmbeddingLayer,
  VisionSidecarOcrLayer,
  VisionSidecarFaceDetectionLayer,
  VisionSidecarImageLabelingLayer,
} from "./adapters/vision-sidecar";
import { PgvectorMemoryLayer } from "./adapters/pgvector";
import type {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  Memory,
} from "./ports";

export type IntelligencePorts =
  | Completion
  | ImageEmbedding
  | TextEmbedding
  | Ocr
  | FaceDetection
  | ImageLabeling
  | Memory;

/** Embedded tier (rank 100) — Anthropic + vendored vision sidecar + pgvector. */
export const EmbeddedIntelligenceLayer = Layer.mergeAll(
  AnthropicCompletionLayer,
  VisionSidecarImageEmbeddingLayer,
  VisionSidecarTextEmbeddingLayer,
  VisionSidecarOcrLayer,
  VisionSidecarFaceDetectionLayer,
  VisionSidecarImageLabelingLayer,
  PgvectorMemoryLayer
);

/**
 * Resolve the best available intelligence Layer.
 * PLEXO_URL set → federated tier (rank 200); else embedded (rank 100).
 */
export function resolveIntelligenceLayer(): Layer.Layer<IntelligencePorts> {
  if (process.env.PLEXO_URL) {
    return PlexoFederatedLayer as unknown as Layer.Layer<IntelligencePorts>;
  }
  return EmbeddedIntelligenceLayer as unknown as Layer.Layer<IntelligencePorts>;
}

export { PlexoFederatedLayer };
