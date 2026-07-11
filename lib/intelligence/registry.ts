// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Jex intelligence registry (ADR-001 §invariants, ADR-003 §resolution).
//
// resolveIntelligenceLayer() returns a Layer providing all 7 ports where EACH
// PORT resolves its winning adapter PER CALL against an ordered tier list:
//   federated (rank 200, when PLEXO_URL set) → embedded (rank 100, always).
// A tier that fails on a given call falls through to the next lower tier for
// that call only (ADR-001 inv 5). The embedded tier is the permanent floor
// (inv 6). Every resolved call logs the tier that served it (ADR-001 risk
// mitigation: per-capability attribution).
//
// ponytail: liveness here is env-presence of PLEXO_URL, not the connection-
// stream liveness ADR-003 specifies for the full Jex mesh. That is a pilot
// simplification — the fallback path (federated throws → embedded serves) is
// real and per-call; upgrade to stream liveness lands with the Jex SDK.

import { Cause, Context, Effect, Exit, Layer } from "effect";
import {
  PlexoFederatedCompletionLayer,
  PlexoFederatedImageEmbeddingLayer,
  PlexoFederatedTextEmbeddingLayer,
  PlexoFederatedOcrLayer,
  PlexoFederatedFaceDetectionLayer,
  PlexoFederatedImageLabelingLayer,
  PlexoFederatedMemoryLayer,
} from "./adapters/plexo-federated";
import { AnthropicCompletionLayer } from "./adapters/anthropic";
import {
  VisionSidecarImageEmbeddingLayer,
  VisionSidecarTextEmbeddingLayer,
  VisionSidecarOcrLayer,
  VisionSidecarFaceDetectionLayer,
  VisionSidecarImageLabelingLayer,
} from "./adapters/vision-sidecar";
import { PgvectorMemoryLayer } from "./adapters/pgvector";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  Memory,
  CapabilityUnavailableError,
} from "./ports";

export type IntelligencePorts =
  | Completion
  | ImageEmbedding
  | TextEmbedding
  | Ocr
  | FaceDetection
  | ImageLabeling
  | Memory;

const federatedEnabled = (): boolean => !!process.env.PLEXO_URL;

interface Tier<T> {
  readonly tier: string;
  readonly layer: Layer.Layer<T>;
}

/** Ordered tiers for a port: federated first (if enabled) then embedded. */
function tiersFor<T>(embedded: Layer.Layer<T>, federated: Layer.Layer<T>): ReadonlyArray<Tier<T>> {
  return federatedEnabled()
    ? [
        { tier: "federated", layer: federated },
        { tier: "embedded", layer: embedded },
      ]
    : [{ tier: "embedded", layer: embedded }];
}

/**
 * Per-call resolution: invoke the service from each tier in rank order; the
 * first success wins and its tier is logged; a failing tier falls through.
 * If every tier fails, the last failure cause is surfaced (preserving the
 * adapter's typed error, e.g. RateLimitError).
 */
export function resolve<T, S, A, E>(
  tag: Context.Tag<T, S>,
  port: string,
  invoke: (svc: S) => Effect.Effect<A, E>,
  tiers: ReadonlyArray<Tier<T>>,
): Effect.Effect<A, E | CapabilityUnavailableError> {
  return Effect.gen(function* () {
    let lastCause: Cause.Cause<E> | undefined;
    for (const { tier, layer } of tiers) {
      const exit = yield* Effect.exit(
        Effect.flatMap(tag, invoke).pipe(Effect.provide(layer)),
      );
      if (Exit.isSuccess(exit)) {
        yield* Effect.logInfo("jex/resolve").pipe(
          Effect.annotateLogs({ port, tier }),
        );
        return exit.value;
      }
      lastCause = exit.cause;
    }
    return yield* lastCause
      ? Effect.failCause(lastCause)
      : Effect.fail(new CapabilityUnavailableError({ port, reason: "no adapter registered" }));
  });
}

/**
 * The live intelligence layer. Each port is a thin service that performs
 * per-call tier resolution; no port's construction can fail, so one
 * unconfigured adapter never disables the others.
 */
export const IntelligenceLive: Layer.Layer<IntelligencePorts> = Layer.mergeAll(
  Layer.succeed(Completion, {
    complete: (req) =>
      resolve(Completion, "jex/Completion", (s) => s.complete(req),
        tiersFor(AnthropicCompletionLayer, PlexoFederatedCompletionLayer)),
  }),
  Layer.succeed(ImageEmbedding, {
    embed: (req) =>
      resolve(ImageEmbedding, "jex/ImageEmbedding", (s) => s.embed(req),
        tiersFor(VisionSidecarImageEmbeddingLayer, PlexoFederatedImageEmbeddingLayer)),
  }),
  Layer.succeed(TextEmbedding, {
    embed: (req) =>
      resolve(TextEmbedding, "jex/TextEmbedding", (s) => s.embed(req),
        tiersFor(VisionSidecarTextEmbeddingLayer, PlexoFederatedTextEmbeddingLayer)),
  }),
  Layer.succeed(Ocr, {
    ocr: (req) =>
      resolve(Ocr, "jex/Ocr", (s) => s.ocr(req),
        tiersFor(VisionSidecarOcrLayer, PlexoFederatedOcrLayer)),
  }),
  Layer.succeed(FaceDetection, {
    detect: (req) =>
      resolve(FaceDetection, "jex/FaceDetection", (s) => s.detect(req),
        tiersFor(VisionSidecarFaceDetectionLayer, PlexoFederatedFaceDetectionLayer)),
  }),
  Layer.succeed(ImageLabeling, {
    label: (req) =>
      resolve(ImageLabeling, "jex/ImageLabeling", (s) => s.label(req),
        tiersFor(VisionSidecarImageLabelingLayer, PlexoFederatedImageLabelingLayer)),
  }),
  Layer.succeed(Memory, {
    store: (record) =>
      resolve(Memory, "jex/Memory", (s) => s.store(record),
        tiersFor(PgvectorMemoryLayer, PlexoFederatedMemoryLayer)),
    search: (req) =>
      resolve(Memory, "jex/Memory", (s) => s.search(req),
        tiersFor(PgvectorMemoryLayer, PlexoFederatedMemoryLayer)),
  }),
);

/** Resolve the intelligence Layer. Tier selection now happens per call. */
export function resolveIntelligenceLayer(): Layer.Layer<IntelligencePorts> {
  return IntelligenceLive;
}

export type FacadeCapability =
  | "complete"
  | "embedImage"
  | "embedText"
  | "ocr"
  | "label"
  | "detectFaces";

// Config-presence probe, zero network. Answers "is SOME tier plausibly
// configured", not "will the call succeed". Vision capabilities require an
// actual vision URL — BOTH vision adapters (sidecar and federated) call one,
// so a PLEXO_URL-only env must report vision as unconfigured or callers'
// soft-skip gates would pass and every tier would then throw, churning
// BullMQ retries where the old visionConfigured() gate skipped cleanly.
export function capabilityConfigured(name: FacadeCapability): boolean {
  return name === "complete"
    ? !!(process.env.PLEXO_URL || process.env.FONTO_LLM_KEY)
    : !!(process.env.FONTO_VISION_URL || process.env.PLEXO_VISION_URL);
}
