// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Degrade adapter — safe-default Layer for each port.
// Returns empty/null results when AI is genuinely unavailable.

import { Effect, Layer } from "effect";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  Memory,
} from "../ports";

export const DegradeCompletionLayer = Layer.succeed(Completion, {
  complete: (_req) =>
    Effect.succeed({ text: "", inputTokens: 0, outputTokens: 0, model: "degrade" }),
});

export const DegradeImageEmbeddingLayer = Layer.succeed(ImageEmbedding, {
  embed: (_req) => Effect.succeed({ vector: [], modelId: "degrade" }),
});

export const DegradeTextEmbeddingLayer = Layer.succeed(TextEmbedding, {
  embed: (_req) => Effect.succeed({ vector: [], modelId: "degrade" }),
});

export const DegradeOcrLayer = Layer.succeed(Ocr, {
  ocr: (_req) => Effect.succeed({ spans: [], modelId: "degrade" }),
});

export const DegradeFaceDetectionLayer = Layer.succeed(FaceDetection, {
  detect: (_req) => Effect.succeed({ faces: [], modelId: "degrade" }),
});

export const DegradeImageLabelingLayer = Layer.succeed(ImageLabeling, {
  label: (_req) => Effect.succeed({ labels: [], modelId: "degrade" }),
});

export const DegradeMemoryLayer = Layer.succeed(Memory, {
  store: (_record) => Effect.succeed(undefined as void),
  search: (_req) => Effect.succeed([] as const),
});

export const DegradeIntelligenceLayer = Layer.mergeAll(
  DegradeCompletionLayer,
  DegradeImageEmbeddingLayer,
  DegradeTextEmbeddingLayer,
  DegradeOcrLayer,
  DegradeFaceDetectionLayer,
  DegradeImageLabelingLayer,
  DegradeMemoryLayer
);
