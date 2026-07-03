// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo federated adapter — tier 200 (ADR-003).
// Note: plexoAiComplete/plexoStoreMemory require workspaceId (not in Jex port
// interface), so Completion and Memory surface CapabilityUnavailableError and
// direct call sites continue using plexo.ts directly.

import { Effect, Layer } from "effect";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  Memory,
  CapabilityUnavailableError,
  type ImageEmbeddingRequest,
  type TextEmbeddingRequest,
  type OcrRequest,
  type FaceDetectionRequest,
  type ImageLabelingRequest,
  type MemoryRecord,
  type MemorySearchRequest,
  type MemorySearchResult,
} from "../ports";

export const PlexoFederatedCompletionLayer = Layer.succeed(Completion, {
  complete: (_req) =>
    Effect.fail(
      new CapabilityUnavailableError({
        port: "jex/Completion",
        reason:
          "Plexo federated Completion requires workspaceId; use AnthropicCompletionLayer or call plexoAiComplete directly",
      })
    ),
});

export const PlexoFederatedImageEmbeddingLayer = Layer.succeed(ImageEmbedding, {
  embed: (req: ImageEmbeddingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const { embedImage } = await import("@/lib/plexo-vision");
        return await embedImage(req.imageBase64);
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/ImageEmbedding",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),
});

export const PlexoFederatedTextEmbeddingLayer = Layer.succeed(TextEmbedding, {
  embed: (req: TextEmbeddingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const { embedText } = await import("@/lib/plexo-vision");
        return await embedText(req.text);
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/TextEmbedding",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),
});

export const PlexoFederatedOcrLayer = Layer.succeed(Ocr, {
  ocr: (req: OcrRequest) =>
    Effect.tryPromise({
      try: async () => {
        const { ocrImage } = await import("@/lib/plexo-vision");
        const input = req.imageUrl ?? req.imageBase64 ?? "";
        const result = await ocrImage(input, req.lang);
        return {
          spans: result.lines.map((l) => ({ text: l.text, confidence: l.confidence })),
          modelId: result.modelId,
        };
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/Ocr",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),
});

export const PlexoFederatedFaceDetectionLayer = Layer.succeed(FaceDetection, {
  detect: (_req: FaceDetectionRequest) =>
    Effect.fail(
      new CapabilityUnavailableError({
        port: "jex/FaceDetection",
        reason: "Plexo federated face detection not yet implemented; use embedded sidecar",
      })
    ),
});

export const PlexoFederatedImageLabelingLayer = Layer.succeed(ImageLabeling, {
  label: (req: ImageLabelingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const { labelImage } = await import("@/lib/plexo-vision");
        const result = await labelImage(req.imageBase64);
        return {
          labels: result.labels.map((l) => ({ label: l, score: 1 })),
          modelId: result.modelId,
        };
      },
      catch: (err) =>
        new CapabilityUnavailableError({
          port: "jex/ImageLabeling",
          reason: err instanceof Error ? err.message : String(err),
        }),
    }),
});

export const PlexoFederatedMemoryLayer = Layer.succeed(Memory, {
  store: (_record: MemoryRecord) =>
    Effect.fail(
      new CapabilityUnavailableError({
        port: "jex/Memory",
        reason: "Plexo federated Memory requires workspaceId; use PgvectorMemoryLayer or call plexoStoreMemory directly",
      })
    ),
  search: (_req: MemorySearchRequest): Effect.Effect<ReadonlyArray<MemorySearchResult>, CapabilityUnavailableError> =>
    Effect.fail(
      new CapabilityUnavailableError({
        port: "jex/Memory",
        reason: "Plexo federated Memory search not implemented in Jex port; use PgvectorMemoryLayer",
      })
    ),
});

export const PlexoFederatedLayer = Layer.mergeAll(
  PlexoFederatedCompletionLayer,
  PlexoFederatedImageEmbeddingLayer,
  PlexoFederatedTextEmbeddingLayer,
  PlexoFederatedOcrLayer,
  PlexoFederatedFaceDetectionLayer,
  PlexoFederatedImageLabelingLayer,
  PlexoFederatedMemoryLayer
);
