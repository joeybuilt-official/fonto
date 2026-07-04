// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence facade — the ONE composition root that runs the Jex ports for
// Fonto's promise-based domain code. Each method resolves the tiered layer
// (federated Plexo → embedded floor), runs the port once, and returns the
// port result. On capability-unavailable it throws the TYPED
// CapabilityUnavailableError (never a raw 503); callers keep their existing
// degrade handling (skip / null / []). Domain code never learns which tier or
// adapter answered — it only sees the port response or the typed error.

import { Cause, Effect, Exit, Option } from "effect";
import { resolveIntelligenceLayer } from "./registry";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  ImageLabeling,
  FaceDetection,
  CapabilityUnavailableError,
  type CompletionRequest,
  type CompletionResponse,
  type ImageEmbeddingResponse,
  type TextEmbeddingResponse,
  type OcrRequest,
  type OcrResponse,
  type ImageLabelingResponse,
  type FaceDetectionResponse,
} from "./ports";

async function run<A, E>(eff: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  throw (
    failure ??
    new CapabilityUnavailableError({ port: "jex", reason: Cause.pretty(exit.cause) })
  );
}

const provide = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, resolveIntelligenceLayer()) as Effect.Effect<A, E, never>;

export const intelligence = {
  complete: (req: CompletionRequest): Promise<CompletionResponse> =>
    run(provide(Effect.flatMap(Completion, (s) => s.complete(req)))),

  embedImage: (imageBase64: string, mimeType?: string): Promise<ImageEmbeddingResponse> =>
    run(provide(Effect.flatMap(ImageEmbedding, (s) => s.embed({ imageBase64, mimeType })))),

  embedText: (text: string): Promise<TextEmbeddingResponse> =>
    run(provide(Effect.flatMap(TextEmbedding, (s) => s.embed({ text })))),

  ocr: (req: OcrRequest): Promise<OcrResponse> =>
    run(provide(Effect.flatMap(Ocr, (s) => s.ocr(req)))),

  label: (imageBase64: string, topK?: number): Promise<ImageLabelingResponse> =>
    run(provide(Effect.flatMap(ImageLabeling, (s) => s.label({ imageBase64, topK })))),

  detectFaces: (imageBase64: string): Promise<FaceDetectionResponse> =>
    run(provide(Effect.flatMap(FaceDetection, (s) => s.detect({ imageBase64 })))),
};

export { CapabilityUnavailableError };
