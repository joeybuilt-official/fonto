#!/usr/bin/env tsx
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Infra-free assertion test for the Jex tiered resolver (ADR-001/003).
// Locks in the two review criticals fixed in ce0c7e6:
//   1. ports fail INDEPENDENTLY — one unconfigured adapter no longer cascades;
//   2. per-call tier resolution FALLS BACK federated → embedded.
// Plus positive supersession/fallback/attribution via fake Layers (exported
// `resolve`). No DB, no network, no keys — runs anywhere `tsx` runs.
// Usage: npx tsx scripts/test-jex-resolver.ts

import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { resolve, resolveIntelligenceLayer } from "../lib/intelligence/registry";
import {
  Completion,
  ImageEmbedding,
  CapabilityUnavailableError,
} from "../lib/intelligence/ports";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "[PASS]" : "[FAIL]"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

function failErr(exit: Exit.Exit<unknown, unknown>): CapabilityUnavailableError | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  return Option.getOrUndefined(Cause.failureOption(exit.cause)) as
    | CapabilityUnavailableError
    | undefined;
}

const live = () => resolveIntelligenceLayer();
const runImage = () =>
  Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(ImageEmbedding, (s) => s.embed({ imageBase64: "x" })),
      live(),
    ),
  );
const runCompletion = () =>
  Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(Completion, (s) =>
        s.complete({ messages: [{ role: "user", content: "hi" }] }),
      ),
      live(),
    ),
  );

async function main() {
  // A) Non-cascade (embedded, no infra): each port must fail as ITS OWN port,
  //    never borrowing the Completion adapter's failure (the original bug).
  delete process.env.FONTO_VISION_URL;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.FONTO_LLM_KEY;
  delete process.env.FONTO_LLM_BASE_URL;

  const ieA = failErr(await runImage());
  check(
    "A: ImageEmbedding fails as its own port (no Completion cascade)",
    ieA?.port === "jex/ImageEmbedding",
    `port=${ieA?.port} reason=${ieA?.reason}`,
  );
  const cA = failErr(await runCompletion());
  check(
    "A: Completion fails as its own port",
    cA?.port === "jex/Completion",
    `port=${cA?.port} reason=${cA?.reason}`,
  );

  // B) A CONFIGURED tier still surfaces its own failure honestly when the
  //    endpoint is unreachable — the reason must reach the caller.
  process.env.FONTO_VISION_URL = "http://127.0.0.1:1"; // unreachable vision tier
  const ieB = failErr(await runImage());
  check(
    "B: unreachable vision tier surfaces its own reason",
    /vision-sidecar|fetch|ECONNREFUSED|Failed/.test(ieB?.reason ?? ""),
    `reason=${ieB?.reason}`,
  );
  delete process.env.FONTO_VISION_URL;

  // C) Positive paths via fake Layers + the exported resolver.
  class Probe extends Context.Tag("test/Probe")<
    Probe,
    { readonly run: () => Effect.Effect<string, CapabilityUnavailableError> }
  >() {}
  const ok = (label: string) => Layer.succeed(Probe, { run: () => Effect.succeed(label) });
  const down = (why: string) =>
    Layer.succeed(Probe, {
      run: () => Effect.fail(new CapabilityUnavailableError({ port: "test/Probe", reason: why })),
    });
  const call = (tiers: ReadonlyArray<{ tier: string; layer: Layer.Layer<Probe> }>) =>
    Effect.runPromiseExit(resolve(Probe, "test/Probe", (s) => s.run(), tiers));

  const r1 = await call([
    { tier: "federated", layer: ok("FED") },
    { tier: "embedded", layer: ok("EMB") },
  ]);
  check("C: federated supersedes embedded on success", Exit.isSuccess(r1) && r1.value === "FED");

  const r2 = await call([
    { tier: "federated", layer: down("fed down") },
    { tier: "embedded", layer: ok("EMB") },
  ]);
  check("C: federated failure falls back to embedded", Exit.isSuccess(r2) && r2.value === "EMB");

  const r3 = await call([
    { tier: "federated", layer: down("fed down") },
    { tier: "embedded", layer: down("emb down") },
  ]);
  check(
    "C: all tiers fail → failure surfaced (embedded's, last)",
    Exit.isFailure(r3) && failErr(r3)?.reason === "emb down",
    `reason=${failErr(r3)?.reason}`,
  );

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
