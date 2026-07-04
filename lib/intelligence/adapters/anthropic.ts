// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Anthropic embedded-tier Completion adapter (ADR-002 §Completion).
// Uses FONTO_LLM_KEY + optional FONTO_LLM_BASE_URL.

import { Effect, Layer } from "effect";
import Anthropic from "@anthropic-ai/sdk";
import {
  Completion,
  CapabilityUnavailableError,
  RateLimitError,
  ContextLengthError,
  PolicyRejectionError,
  type CompletionError,
  type CompletionRequest,
} from "../ports";

const DEFAULT_MODEL = "claude-haiku-4-5";

function mapError(err: unknown): CompletionError {
  if (err instanceof CapabilityUnavailableError) return err;
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return new RateLimitError({ retryAfterMs: 60_000 });
    if (err.status === 400 && err.message.includes("max_tokens"))
      return new ContextLengthError({ maxTokens: 0 });
    if (err.status === 400 && err.message.toLowerCase().includes("policy"))
      return new PolicyRejectionError({ reason: err.message });
  }
  return new CapabilityUnavailableError({
    port: "jex/Completion",
    reason: err instanceof Error ? err.message : String(err),
  });
}

// Lazy, memoized client. Building the client NEVER fails the Layer — a missing
// key surfaces per-call as CapabilityUnavailableError, so an unconfigured
// Completion adapter can no longer take down the sibling vision/memory ports
// when merged into a shared layer (ADR-001 inv 1/5 — ports fail independently).
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.FONTO_LLM_KEY;
  if (!apiKey) {
    throw new CapabilityUnavailableError({
      port: "jex/Completion",
      reason: "FONTO_LLM_KEY is not set",
    });
  }
  const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey };
  const baseURL = process.env.FONTO_LLM_BASE_URL;
  if (baseURL) opts.baseURL = baseURL;
  _client = new Anthropic(opts);
  return _client;
}

export const AnthropicCompletionLayer = Layer.succeed(Completion, {
  complete: (req: CompletionRequest) =>
    Effect.tryPromise({
      try: async () => {
        const client = getClient();
        const model =
          req.providerHint?.type === "anthropic"
            ? req.providerHint.model
            : (req.model ?? DEFAULT_MODEL);

        const messages = req.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));

        const systemMsg = req.messages.find((m) => m.role === "system");

        const res = await client.messages.create({
          model,
          max_tokens: req.maxTokens ?? 1024,
          messages,
          ...(systemMsg ? { system: systemMsg.content } : {}),
        });

        const text =
          res.content[0]?.type === "text" ? res.content[0].text : "";
        return {
          text,
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          model: res.model,
        };
      },
      catch: mapError,
    }),
});
