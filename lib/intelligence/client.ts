// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence facade — the ONE composition root that runs the Jex ports for
// Fonto's promise-based domain code. Each method resolves the layer (embedded
// adapters), runs the port once, and returns the port result. On
// capability-unavailable it throws the TYPED CapabilityUnavailableError (never
// a raw 503); callers keep their existing degrade handling (skip / null / []).
// Domain code never learns which adapter answered — it only sees the port
// response or the typed error.
//
// Two additions over the raw ports:
//   - `completeForUser(userId, req)` resolves the user's own AI connection
//     (falling back to the deployment default) and hands it to the Completion
//     adapter. That is what makes the model/provider a user-configurable input.
//   - `storeMemory` / `searchMemory` drive the pgvector Memory port so the
//     semantic-search path is app-owned end to end (embed with the vision
//     tier, store/query locally).

import { Cause, Effect, Exit, Option } from "effect";
import {
  resolveIntelligenceLayer,
  capabilityConfigured,
  type FacadeCapability,
} from "./registry";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  ImageLabeling,
  FaceDetection,
  Memory,
  CapabilityUnavailableError,
  type CompletionRequest,
  type CompletionResponse,
  type ConnectionSpec,
  type ImageEmbeddingResponse,
  type TextEmbeddingResponse,
  type OcrRequest,
  type OcrResponse,
  type ImageLabelingResponse,
  type FaceDetectionResponse,
  type MemoryRecord,
  type MemorySearchRequest,
  type MemorySearchResult,
} from "./ports";
import { resolveAiConnectionOrNull } from "@/lib/ai/connections";
import { logger } from "@/lib/logger";

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

  /**
   * Complete a request with the given user's own AI connection, falling back to
   * the deployment's env-default connection when the user has none. When
   * neither exists the adapter surfaces the typed CapabilityUnavailableError —
   * callers degrade, never 503.
   */
  completeForUser: async (
    userId: string | null | undefined,
    req: CompletionRequest,
  ): Promise<CompletionResponse> => {
    const connection = await resolveAiConnectionOrNull(userId);
    if (connection) {
      const spec: ConnectionSpec = {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model: connection.model,
      };
      return intelligence.complete({ ...req, connection: spec });
    }
    return intelligence.complete(req);
  },

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

  storeMemory: (record: MemoryRecord): Promise<void> =>
    run(provide(Effect.flatMap(Memory, (s) => s.store(record)))),

  searchMemory: (req: MemorySearchRequest): Promise<ReadonlyArray<MemorySearchResult>> =>
    run(provide(Effect.flatMap(Memory, (s) => s.search(req)))),

  available: (capability: FacadeCapability): boolean =>
    capabilityConfigured(capability),
};

/**
 * Store a memory row for an asset, embedding its content with the vision
 * tier's text model. The record id is the ASSET id, so a later search returns
 * asset ids directly and callers can match without a second mapping.
 *
 * Non-fatal by contract: returns false (and logs) when the embedding tier is
 * unavailable — the memory row is a search enhancement, never a core flow.
 */
export async function storeAssetMemory(
  assetId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  if (!intelligence.available("embedText")) return false;
  try {
    const { vector } = await intelligence.embedText(content);
    await intelligence.storeMemory({
      id: assetId,
      content,
      vector: [...vector],
      metadata,
    });
    return true;
  } catch (err) {
    logger.warn({ err, assetId }, "[fonto] asset memory write skipped");
    return false;
  }
}

export { CapabilityUnavailableError };
export type { FacadeCapability };
