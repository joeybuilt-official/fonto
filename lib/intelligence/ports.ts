// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Jex ADR-002: seven narrow intelligence ports.
// Uses Context.GenericTag for service tags + interface types for implementations.
// Errors use Data.TaggedError — typed at compile time.

import { Context, Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Error taxonomy (ADR-002 §Decision)
// ---------------------------------------------------------------------------

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly retryAfterMs: number;
}> {}

export class ContextLengthError extends Data.TaggedError("ContextLengthError")<{
  readonly maxTokens: number;
}> {}

export class PolicyRejectionError extends Data.TaggedError("PolicyRejectionError")<{
  readonly reason: string;
}> {}

export class CapabilityUnavailableError extends Data.TaggedError(
  "CapabilityUnavailableError"
)<{
  readonly port: string;
  readonly reason: string;
}> {}

// ---------------------------------------------------------------------------
// Port 1: Completion
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly content: string;
  }>;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly providerHint?: { readonly type: "anthropic"; readonly model: string };
  // Tenant context for the federated (Plexo) adapter — Plexo's aiComplete is
  // workspace-scoped. Ignored by the embedded (direct-provider) adapter.
  readonly workspaceId?: string;
}

export interface CompletionResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

export type CompletionError =
  | RateLimitError
  | ContextLengthError
  | PolicyRejectionError
  | CapabilityUnavailableError;

export interface CompletionService {
  readonly complete: (
    req: CompletionRequest
  ) => Effect.Effect<CompletionResponse, CompletionError>;
}

export class Completion extends Context.Tag("jex/Completion")<
  Completion,
  CompletionService
>() {}

// ---------------------------------------------------------------------------
// Port 2: ImageEmbedding
// ---------------------------------------------------------------------------

export interface ImageEmbeddingRequest {
  readonly imageBase64: string;
  readonly mimeType?: string;
}

export interface ImageEmbeddingResponse {
  readonly vector: ReadonlyArray<number>;
  readonly modelId: string;
}

export type ImageEmbeddingError = CapabilityUnavailableError;

export interface ImageEmbeddingService {
  readonly embed: (
    req: ImageEmbeddingRequest
  ) => Effect.Effect<ImageEmbeddingResponse, ImageEmbeddingError>;
}

export class ImageEmbedding extends Context.Tag("jex/ImageEmbedding")<
  ImageEmbedding,
  ImageEmbeddingService
>() {}

// ---------------------------------------------------------------------------
// Port 3: TextEmbedding
// ---------------------------------------------------------------------------

export interface TextEmbeddingRequest {
  readonly text: string;
}

export interface TextEmbeddingResponse {
  readonly vector: ReadonlyArray<number>;
  readonly modelId: string;
}

export type TextEmbeddingError = CapabilityUnavailableError;

export interface TextEmbeddingService {
  readonly embed: (
    req: TextEmbeddingRequest
  ) => Effect.Effect<TextEmbeddingResponse, TextEmbeddingError>;
}

export class TextEmbedding extends Context.Tag("jex/TextEmbedding")<
  TextEmbedding,
  TextEmbeddingService
>() {}

// ---------------------------------------------------------------------------
// Port 4: Ocr
// ---------------------------------------------------------------------------

export interface OcrRequest {
  readonly imageBase64?: string;
  readonly imageUrl?: string;
  readonly lang?: string;
}

export interface OcrSpan {
  readonly text: string;
  readonly confidence: number;
}

export interface OcrResponse {
  readonly spans: ReadonlyArray<OcrSpan>;
  readonly modelId: string;
}

export type OcrError = CapabilityUnavailableError;

export interface OcrService {
  readonly ocr: (req: OcrRequest) => Effect.Effect<OcrResponse, OcrError>;
}

export class Ocr extends Context.Tag("jex/Ocr")<Ocr, OcrService>() {}

// ---------------------------------------------------------------------------
// Port 5: FaceDetection
// ---------------------------------------------------------------------------

export interface FaceDetectionRequest {
  readonly imageBase64: string;
}

export interface FaceBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DetectedFace {
  readonly boundingBox: FaceBoundingBox;
  readonly embedding: ReadonlyArray<number>;
  readonly confidence: number;
}

export interface FaceDetectionResponse {
  readonly faces: ReadonlyArray<DetectedFace>;
  readonly modelId: string;
}

export type FaceDetectionError = CapabilityUnavailableError;

export interface FaceDetectionService {
  readonly detect: (
    req: FaceDetectionRequest
  ) => Effect.Effect<FaceDetectionResponse, FaceDetectionError>;
}

export class FaceDetection extends Context.Tag("jex/FaceDetection")<
  FaceDetection,
  FaceDetectionService
>() {}

// ---------------------------------------------------------------------------
// Port 6: ImageLabeling
// ---------------------------------------------------------------------------

export interface ImageLabelingRequest {
  readonly imageBase64: string;
  readonly topK?: number;
}

export interface ImageLabel {
  readonly label: string;
  readonly score: number;
}

export interface ImageLabelingResponse {
  readonly labels: ReadonlyArray<ImageLabel>;
  readonly modelId: string;
}

export type ImageLabelingError = CapabilityUnavailableError;

export interface ImageLabelingService {
  readonly label: (
    req: ImageLabelingRequest
  ) => Effect.Effect<ImageLabelingResponse, ImageLabelingError>;
}

export class ImageLabeling extends Context.Tag("jex/ImageLabeling")<
  ImageLabeling,
  ImageLabelingService
>() {}

// ---------------------------------------------------------------------------
// Port 7: Memory
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly vector: ReadonlyArray<number>;
  readonly metadata?: Record<string, unknown>;
}

export interface MemorySearchRequest {
  readonly queryVector: ReadonlyArray<number>;
  readonly topK?: number;
  readonly threshold?: number;
}

export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

export type MemoryError = CapabilityUnavailableError;

export interface MemoryService {
  readonly store: (record: MemoryRecord) => Effect.Effect<void, MemoryError>;
  readonly search: (
    req: MemorySearchRequest
  ) => Effect.Effect<ReadonlyArray<MemorySearchResult>, MemoryError>;
}

export class Memory extends Context.Tag("jex/Memory")<Memory, MemoryService>() {}
