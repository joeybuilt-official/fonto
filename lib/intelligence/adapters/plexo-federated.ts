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
  complete: (req) =>
    Effect.tryPromise({
      try: async () => {
        if (!req.workspaceId) {
          throw new CapabilityUnavailableError({
            port: "jex/Completion",
            reason: "federated Completion needs workspaceId",
          });
        }
        const { plexoAiComplete } = await import("@/lib/plexo");
        const text = await plexoAiComplete(
          req.workspaceId,
          req.messages.map((m) => ({ role: m.role, content: m.content })),
          req.maxTokens
        );
        return { text, inputTokens: 0, outputTokens: 0, model: "plexo" };
      },
      catch: (err) =>
        err instanceof CapabilityUnavailableError
          ? err
          : new CapabilityUnavailableError({
              port: "jex/Completion",
              reason: err instanceof Error ? err.message : String(err),
            }),
    }),
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
          spans: result.lines.map((l) => ({
            text: l.text,
            confidence: l.confidence,
            // ocrImage defaults missing bbox to [0,0,0,0] — drop zero-area.
            ...(l.bbox[2] > 0 && l.bbox[3] > 0 ? { bbox: l.bbox } : {}),
          })),
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
  detect: (req: FaceDetectionRequest) =>
    Effect.tryPromise({
      try: async () => {
        const base = (process.env.PLEXO_VISION_URL ?? "").replace(/\/+$/, "");
        if (!base) {
          throw new CapabilityUnavailableError({
            port: "jex/FaceDetection",
            reason: "PLEXO_VISION_URL is not set",
          });
        }
        const res = await fetch(`${base}/v1/faces/detect`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.PLEXO_SERVICE_KEY
              ? { authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY}` }
              : {}),
          },
          body: JSON.stringify({ image: req.imageBase64 }),
        });
        if (!res.ok) throw new Error(`faces/detect HTTP ${res.status}`);
        const data = (await res.json()) as {
          faces?: Array<{
            bbox?: { x?: number; y?: number; w?: number; h?: number };
            confidence?: number;
            embedding?: number[];
          }>;
          modelId?: string;
        };
        const faces = (data.faces ?? []).map((f) => ({
          boundingBox: { x: f.bbox?.x ?? 0, y: f.bbox?.y ?? 0, width: f.bbox?.w ?? 0, height: f.bbox?.h ?? 0 },
          embedding: f.embedding ?? [],
          confidence: f.confidence ?? 0,
        }));
        return { faces, modelId: data.modelId ?? "arcface" };
      },
      catch: (err) =>
        err instanceof CapabilityUnavailableError
          ? err
          : new CapabilityUnavailableError({
              port: "jex/FaceDetection",
              reason: err instanceof Error ? err.message : String(err),
            }),
    }),
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
