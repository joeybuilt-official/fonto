// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Embedded-tier Completion adapter (ADR-002 §Completion).
//
// Speaks the Anthropic Messages API. The connection it uses is resolved by the
// caller (`lib/ai/connections.ts` — a per-user connection, else the deployment
// default) and handed in as `req.connection`. When no connection is supplied
// the adapter falls back to the deployment's own environment:
//
//   AI_BASE_URL / AI_API_KEY / AI_MODEL, with the legacy FONTO_LLM_* names
//   honored so an existing install keeps working without an env change.
//
// A missing key surfaces per-call as CapabilityUnavailableError — the Layer
// itself never fails, so an unconfigured Completion adapter cannot take down
// the sibling vision/memory ports (ADR-001 inv 1/5 — ports fail independently).

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

const DEFAULT_MODEL = "auto";

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

/**
 * Normalise a connection base URL to what the Anthropic SDK wants.
 *
 * The app's connection model documents an OpenAI-COMPATIBLE base URL, which by
 * convention carries the version segment (e.g. `http://gateway:4000/v1`, the
 * same shape Levio/Fylo use for `{baseUrl}/chat/completions`). The Anthropic
 * SDK appends `/v1/messages` itself, so a base URL ending in `/v1` would be
 * requested as `/v1/v1/messages` — a 404 on every gateway. Strip one trailing
 * `/v1` (and any trailing slash). A URL without the version segment passes
 * through unchanged, which keeps `https://api.anthropic.com` working.
 */
function sdkBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
}

/**
 * Resolve the call's provider config, preferring the caller-supplied
 * connection (the user's own, or the deployment default resolved upstream) and
 * falling back to the deployment environment.
 */
function resolveProviderConfig(req: CompletionRequest): {
  baseURL: string | undefined;
  apiKey: string;
  model: string;
} {
  if (req.connection) {
    return {
      baseURL: sdkBaseUrl(req.connection.baseUrl),
      apiKey: req.connection.apiKey,
      model: req.model ?? req.connection.model,
    };
  }
  const apiKey = process.env.AI_API_KEY ?? process.env.FONTO_LLM_KEY;
  if (!apiKey) {
    throw new CapabilityUnavailableError({
      port: "jex/Completion",
      reason:
        "no AI connection configured — set a per-user connection in Settings or AI_BASE_URL/AI_API_KEY/AI_MODEL on the deployment",
    });
  }
  const rawBaseUrl = process.env.AI_BASE_URL ?? process.env.FONTO_LLM_BASE_URL;
  const baseURL = rawBaseUrl ? sdkBaseUrl(rawBaseUrl) : undefined;
  return {
    baseURL,
    apiKey,
    model: req.model ?? process.env.AI_MODEL ?? DEFAULT_MODEL,
  };
}

// Client cache keyed by (baseURL, apiKey) so a per-user connection does not
// rebuild a client per call, while two users never share one. Bounded: the
// cache holds at most CLIENT_CACHE_MAX entries, oldest evicted first — a
// deployment with many users must not accumulate unbounded clients.
const CLIENT_CACHE_MAX = 32;
const clientCache = new Map<string, Anthropic>();

function getClient(cfg: { baseURL: string | undefined; apiKey: string }): Anthropic {
  const key = `${cfg.baseURL ?? "https://api.anthropic.com"}\x00${cfg.apiKey}`;
  const hit = clientCache.get(key);
  if (hit) return hit;
  const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey: cfg.apiKey };
  if (cfg.baseURL) opts.baseURL = cfg.baseURL;
  const client = new Anthropic(opts);
  if (clientCache.size >= CLIENT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  clientCache.set(key, client);
  return client;
}

export const AnthropicCompletionLayer = Layer.succeed(Completion, {
  complete: (req: CompletionRequest) =>
    Effect.tryPromise({
      try: async () => {
        const cfg = resolveProviderConfig(req);
        const client = getClient(cfg);

        const messages = req.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));

        const systemMsg = req.messages.find((m) => m.role === "system");

        const res = await client.messages.create({
          model: cfg.model,
          max_tokens: req.maxTokens ?? 1024,
          messages,
          ...(systemMsg ? { system: systemMsg.content } : {}),
        });

        // Gateways vary in what they put first: a reasoning/thinking block
        // often precedes the answer (observed on a LiteLLM gateway with an
        // `auto` model). Take the first TEXT block rather than assuming
        // `content[0]` is the answer, or the caption comes back empty while
        // tokens were billed.
        const textBlock = res.content.find((b) => b.type === "text");
        const text = textBlock?.type === "text" ? textBlock.text : "";
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
