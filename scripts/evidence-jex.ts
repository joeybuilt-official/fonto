#!/usr/bin/env tsx
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Evidence script — runs all 7 Jex ports once with sample input.
// Usage: npx tsx scripts/evidence-jex.ts

import { Effect, Exit } from "effect";
import { resolveIntelligenceLayer } from "../lib/intelligence/registry";
import {
  Completion,
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  Memory,
} from "../lib/intelligence/ports";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function runPort<A, E>(name: string, effect: Effect.Effect<A, E, never>): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    const val = exit.value;
    const summary =
      typeof val === "object" && val !== null
        ? JSON.stringify(val).slice(0, 120)
        : String(val);
    console.log(`[OK] ${name}: ${summary}`);
  } else {
    console.log(`[FAIL] ${name}: ${JSON.stringify(exit.cause).slice(0, 200)}`);
  }
}

async function main() {
  const tierName = "embedded (tier 100)";
  console.log(`Jex evidence run — tier: ${tierName}\n`);

  const layer = resolveIntelligenceLayer();

  function provide<A, E, R extends
    | Completion | ImageEmbedding | TextEmbedding | Ocr
    | FaceDetection | ImageLabeling | Memory
  >(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> {
    return Effect.provide(eff, layer) as Effect.Effect<A, E, never>;
  }

  await runPort(
    "Completion",
    provide(
      Effect.flatMap(Completion, (svc) =>
        svc.complete({ messages: [{ role: "user", content: "Say hi in one word." }], maxTokens: 10 })
      )
    )
  );

  await runPort(
    "ImageEmbedding",
    provide(Effect.flatMap(ImageEmbedding, (svc) => svc.embed({ imageBase64: TINY_PNG_B64 })))
  );

  await runPort(
    "TextEmbedding",
    provide(Effect.flatMap(TextEmbedding, (svc) => svc.embed({ text: "sunset over the ocean" })))
  );

  await runPort(
    "Ocr",
    provide(Effect.flatMap(Ocr, (svc) => svc.ocr({ imageBase64: TINY_PNG_B64 })))
  );

  await runPort(
    "FaceDetection",
    provide(Effect.flatMap(FaceDetection, (svc) => svc.detect({ imageBase64: TINY_PNG_B64 })))
  );

  await runPort(
    "ImageLabeling",
    provide(Effect.flatMap(ImageLabeling, (svc) => svc.label({ imageBase64: TINY_PNG_B64, topK: 5 })))
  );

  const dummyVector = Array.from({ length: 512 }, () => Math.random() * 2 - 1);

  await runPort(
    "Memory.store",
    provide(
      Effect.flatMap(Memory, (svc) =>
        svc.store({
          id: "00000000-0000-0000-0000-000000000001",
          content: "Jex evidence test record",
          vector: dummyVector,
          metadata: { source: "evidence-jex" },
        })
      )
    )
  );

  await runPort(
    "Memory.search",
    provide(Effect.flatMap(Memory, (svc) => svc.search({ queryVector: dummyVector, topK: 3 })))
  );

  console.log("\nEvidence run complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
