// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Jex intelligence registry (ADR-001 §invariants, ADR-003 §resolution).
//
// `resolveIntelligenceLayer()` returns a Layer providing all 7 ports where EACH
// PORT resolves its winning adapter PER CALL against an ordered tier list.
//
// ONE MANDATORY TIER, ONE OPTIONAL:
//   - embedded (rank 100, ALWAYS) — the app's own adapters: a Completion call
//     through the connection the caller supplied (the user's own, or the
//     deployment default), and the vision sidecar at FONTO_VISION_URL for the
//     vision ports. Ships with the app; needs no peer.
//   - federated (rank 200, ONLY when the deployment configures a remote peer
//     AND has not pinned it off) — an optional OpenAI-compatible endpoint.
//     Unset configuration means the tier does not exist, which is a normal
//     state: resolution simply never selects it.
//
// A tier that fails on a given call falls through to the next lower tier for
// that call only (ADR-001 inv 5). The embedded tier is the permanent floor
// (inv 6). Every resolved call logs the tier that served it (ADR-001 risk
// mitigation: per-capability attribution).
//
// Nothing here blocks on a peer and nothing throws when one is missing — that
// absence is exactly the case the embedded floor exists to cover.

import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { describeError } from "@/lib/errors/describeError";
import { AnthropicCompletionLayer } from "./adapters/anthropic";
import {
  VisionSidecarImageEmbeddingLayer,
  VisionSidecarTextEmbeddingLayer,
  VisionSidecarOcrLayer,
  VisionSidecarFaceDetectionLayer,
  VisionSidecarImageLabelingLayer,
  visionSidecarUrl,
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

/**
 * Kill-switch read, checked per resolve so a flip applies without a restart.
 * `JEX_FEDERATION_OFF=1` pins resolution to the embedded tier.
 */
export function isFederationOff(): boolean {
  const v = process.env.JEX_FEDERATION_OFF;
  return v === "1" || v === "true";
}

interface Tier<T> {
  readonly tier: string;
  readonly layer: Layer.Layer<T>;
}

/** Ordered tiers for a port: the app's own adapter, always present. */
function tiersFor<T>(embedded: Layer.Layer<T>): ReadonlyArray<Tier<T>> {
  return [{ tier: "embedded", layer: embedded }];
}

/**
 * Per-call resolution: invoke the service from each tier in rank order; the
 * first success wins and its tier is logged; a failing tier falls through.
 *
 * When EVERY tier fails, the reason from every tier is preserved, not just the
 * last one. Surfacing only the last cause is how a real outage got misreported
 * on 2026-09-04: the preferred tier failed with its actual explanation, the
 * embedded tier then failed with an empty-message CapabilityUnavailableError,
 * and only that second, emptier error reached the caller — so the pipeline
 * recorded nothing usable and the true cause took a Redis-and-container-log
 * excavation to recover.
 *
 * A typed non-capability error (e.g. RateLimitError) is still surfaced
 * unchanged, because callers match on its type to decide whether to retry.
 */
/**
 * A non-empty reason for a failed tier. Prefers the typed failure (so a tagged
 * error's fields survive) and falls back to the rendered cause for a defect or
 * interruption, which carry no failure value at all.
 */
function describeCause<E>(cause: Cause.Cause<E>): string {
  const failure = Option.getOrNull(Cause.failureOption(cause));
  if (failure !== null) return describeError(failure);
  return Cause.pretty(cause).split("\n")[0] || "unknown cause";
}

export function resolve<T, S, A, E>(
  tag: Context.Tag<T, S>,
  port: string,
  invoke: (svc: S) => Effect.Effect<A, E>,
  tiers: ReadonlyArray<Tier<T>>,
): Effect.Effect<A, E | CapabilityUnavailableError> {
  return Effect.gen(function* () {
    let lastCause: Cause.Cause<E> | undefined;
    const attempts: string[] = [];
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
      const reason = describeCause(exit.cause);
      attempts.push(`${tier}: ${reason}`);
      // Per-tier attribution at the moment of failure. Without this a
      // fall-through is invisible until something downstream reports a
      // symptom far from its cause.
      yield* Effect.logWarning("jex/tier-failed").pipe(
        Effect.annotateLogs({ port, tier, reason }),
      );
    }
    if (!lastCause) {
      return yield* Effect.fail(
        new CapabilityUnavailableError({ port, reason: "no adapter registered" }),
      );
    }
    // Every tier failed. If the final failure is a capability error, rebuild it
    // with EVERY tier's reason — same type, so `instanceof` checks at call
    // sites keep working, but the message now names what actually happened.
    const lastFailure = Option.getOrNull(Cause.failureOption(lastCause));
    if (lastFailure instanceof CapabilityUnavailableError) {
      return yield* Effect.fail(
        new CapabilityUnavailableError({ port, reason: attempts.join(" | ") }),
      );
    }
    return yield* Effect.failCause(lastCause);
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
        tiersFor(AnthropicCompletionLayer)),
  }),
  Layer.succeed(ImageEmbedding, {
    embed: (req) =>
      resolve(ImageEmbedding, "jex/ImageEmbedding", (s) => s.embed(req),
        tiersFor(VisionSidecarImageEmbeddingLayer)),
  }),
  Layer.succeed(TextEmbedding, {
    embed: (req) =>
      resolve(TextEmbedding, "jex/TextEmbedding", (s) => s.embed(req),
        tiersFor(VisionSidecarTextEmbeddingLayer)),
  }),
  Layer.succeed(Ocr, {
    ocr: (req) =>
      resolve(Ocr, "jex/Ocr", (s) => s.ocr(req),
        tiersFor(VisionSidecarOcrLayer)),
  }),
  Layer.succeed(FaceDetection, {
    detect: (req) =>
      resolve(FaceDetection, "jex/FaceDetection", (s) => s.detect(req),
        tiersFor(VisionSidecarFaceDetectionLayer)),
  }),
  Layer.succeed(ImageLabeling, {
    label: (req) =>
      resolve(ImageLabeling, "jex/ImageLabeling", (s) => s.label(req),
        tiersFor(VisionSidecarImageLabelingLayer)),
  }),
  Layer.succeed(Memory, {
    store: (record) =>
      resolve(Memory, "jex/Memory", (s) => s.store(record),
        tiersFor(PgvectorMemoryLayer)),
    search: (req) =>
      resolve(Memory, "jex/Memory", (s) => s.search(req),
        tiersFor(PgvectorMemoryLayer)),
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
// actual vision URL — the sidecar adapter calls one, so an AI-only env must
// report vision as unconfigured or callers' soft-skip gates would pass and
// every tier would then throw, churning BullMQ retries where the old
// visionConfigured() gate skipped cleanly.
export function capabilityConfigured(name: FacadeCapability): boolean {
  return name === "complete"
    ? !!(process.env.AI_BASE_URL || process.env.AI_API_KEY || process.env.FONTO_LLM_KEY)
    : !!visionSidecarUrl();
}
