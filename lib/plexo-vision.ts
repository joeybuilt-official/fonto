// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.2 — Plexo Vision (CLIP) client.
//
// Thin HTTP facade in front of the `apps/vision` service shipped by Plexo in
// Phase 4.1. The vision service exposes two CLIP endpoints:
//   POST /vision/clip/image  { image: base64 } → { vector, modelId }
//   POST /vision/clip/text   { text }          → { vector, modelId }
//
// Vectors are L2-normalised floats (OpenCLIP). Callers don't care about
// dimensionality here; they just hand the raw `number[]` to pgvector.
//
// Authentication reuses the same `PLEXO_SERVICE_KEY` Plexo Core uses — the
// vision service trusts the shared platform secret rather than minting its
// own. If either `PLEXO_VISION_URL` or `PLEXO_SERVICE_KEY` is unset, every
// call short-circuits to throw. Callers MUST guard with `visionConfigured()`
// or handle the error gracefully.
//
// Timeout: 15 s per request. Throws on any non-2xx (callers wrap with their
// own try/catch + degradation logic).
//
// AGPL note: OpenCLIP weights are MIT-licensed; running them inside our own
// ONNX runtime is fine to ship with an AGPL app.

const VISION_TIMEOUT_MS = 15_000;

let cachedModelId: string | null = null;

/** Read env each call so dynamic env changes (tests, restart) are observed. */
function visionUrl(): string {
  return process.env.PLEXO_VISION_URL ?? "http://plexo-vision:7000";
}

function serviceKey(): string {
  return process.env.PLEXO_SERVICE_KEY ?? "";
}

/**
 * True iff both the vision URL and the shared service key are set. Routes
 * that need to degrade gracefully ("unavailable") branch on this before
 * touching the vision client.
 */
export function visionConfigured(): boolean {
  return Boolean(process.env.PLEXO_VISION_URL) && Boolean(process.env.PLEXO_SERVICE_KEY);
}

/** Last-seen model id from the vision service, if any. */
export function lastSeenModelId(): string | null {
  return cachedModelId;
}

export interface EmbedResult {
  vector: number[];
  modelId: string;
}

interface VisionResponseBody {
  vector?: unknown;
  modelId?: unknown;
  model_id?: unknown;
}

function parseEmbedBody(raw: unknown): EmbedResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("vision: malformed response (expected object)");
  }
  const body = raw as VisionResponseBody;
  const vec = body.vector;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("vision: malformed response (missing vector array)");
  }
  const numeric: number[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`vision: malformed vector element at index ${i}`);
    }
    numeric[i] = v;
  }
  const modelId =
    typeof body.modelId === "string"
      ? body.modelId
      : typeof body.model_id === "string"
        ? body.model_id
        : "unknown";
  cachedModelId = modelId;
  return { vector: numeric, modelId };
}

async function postJson(path: string, body: unknown): Promise<EmbedResult> {
  if (!visionConfigured()) {
    throw new Error(
      "vision: PLEXO_VISION_URL or PLEXO_SERVICE_KEY not configured"
    );
  }
  const url = `${visionUrl().replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey()}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* swallow */
      }
      throw new Error(`vision: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = (await res.json()) as unknown;
    return parseEmbedBody(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed an image. Accepts either a `Buffer` (raw image bytes) or a
 * `string` (already-base64 payload, no data: URL prefix). The vision
 * service decodes + preprocesses internally; we send the bytes intact.
 *
 * Throws on transport error, non-2xx, or malformed response. Callers in
 * the worker/queue must catch and either retry (BullMQ) or move on.
 */
export async function embedImage(buffer: Buffer | string): Promise<EmbedResult> {
  const image = typeof buffer === "string" ? buffer : buffer.toString("base64");
  return postJson("/vision/clip/image", { image });
}

/**
 * Embed a free-text query for CLIP text-to-image retrieval. The returned
 * vector shares a unit-norm latent space with `embedImage()` output, so the
 * caller can compute cosine similarity directly against `assets.clip_vec`.
 */
export async function embedText(text: string): Promise<EmbedResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("vision: empty text payload");
  }
  return postJson("/vision/clip/text", { text: trimmed });
}
