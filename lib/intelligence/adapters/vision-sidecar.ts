// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Vision sidecar adapter — implements ImageEmbedding, TextEmbedding, Ocr,
// FaceDetection, ImageLabeling by HTTP-calling FONTO_VISION_URL.
//
// The sidecar is OPTIONAL. When FONTO_VISION_URL is unset the capability is not
// advertised; a call resolves to a typed CapabilityUnavailableError and callers
// degrade (skip / null / []). No core flow depends on it being reachable.
//
// The service key is the deployment's OWN (`FONTO_VISION_KEY`) — Fonto holds no
// sibling app's credential. Unset means an unauthenticated call, which is the
// correct shape for a self-hosted sidecar on a private network.

import { Effect, Layer } from "effect";
import {
  ImageEmbedding,
  TextEmbedding,
  Ocr,
  FaceDetection,
  ImageLabeling,
  CapabilityUnavailableError,
  type ImageEmbeddingRequest,
  type TextEmbeddingRequest,
  type OcrRequest,
  type FaceDetectionRequest,
  type ImageLabelingRequest,
} from "../ports";

const DEFAULT_TIMEOUT_MS = 15_000;
const OCR_TIMEOUT_MS = 300_000;

export function visionSidecarUrl(): string {
  return (process.env.FONTO_VISION_URL ?? "").replace(/\/+$/, "");
}

function serviceKey(): string {
  return process.env.FONTO_VISION_KEY ?? "";
}

async function sidecarPost<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const base = visionSidecarUrl();
  if (!base) throw new Error("FONTO_VISION_URL is not set");
  const url = base + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(serviceKey() ? { authorization: `Bearer ${serviceKey()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vision-sidecar ${path} HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(port: string, reason: string): CapabilityUnavailableError {
  return new CapabilityUnavailableError({ port, reason });
}

// ---------------------------------------------------------------------------
// ImageEmbedding
// ---------------------------------------------------------------------------

export const VisionSidecarImageEmbeddingLayer = Layer.succeed(ImageEmbedding, {
  embed: (req: ImageEmbeddingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const data = await sidecarPost<{ vector?: number[]; modelId?: string; model_id?: string }>(
          "/vision/clip/image",
          { image: req.imageBase64 }
        );
        return { vector: data.vector ?? [], modelId: data.modelId ?? data.model_id ?? "openclip-vit-b-32" };
      },
      catch: (err) => unavailable("jex/ImageEmbedding", err instanceof Error ? err.message : String(err)),
    }),
});

// ---------------------------------------------------------------------------
// TextEmbedding
// ---------------------------------------------------------------------------

export const VisionSidecarTextEmbeddingLayer = Layer.succeed(TextEmbedding, {
  embed: (req: TextEmbeddingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const data = await sidecarPost<{ vector?: number[]; modelId?: string; model_id?: string }>(
          "/vision/clip/text",
          { text: req.text }
        );
        return { vector: data.vector ?? [], modelId: data.modelId ?? data.model_id ?? "openclip-vit-b-32" };
      },
      catch: (err) => unavailable("jex/TextEmbedding", err instanceof Error ? err.message : String(err)),
    }),
});

// ---------------------------------------------------------------------------
// Ocr
// ---------------------------------------------------------------------------

export const VisionSidecarOcrLayer = Layer.succeed(Ocr, {
  ocr: (req: OcrRequest) =>
    Effect.tryPromise({
      try: async () => {
        const body: Record<string, unknown> = { lang: req.lang ?? process.env.OCR_DEFAULT_LANG ?? "en" };
        if (req.imageUrl) body.imageUrl = req.imageUrl;
        else if (req.imageBase64) body.imageBase64 = req.imageBase64;

        const data = await sidecarPost<{
          lines?: Array<{ text?: string; confidence?: number; bbox?: unknown }>;
          modelId?: string;
          model_id?: string;
          model?: string;
        }>("/vision/ocr", body, OCR_TIMEOUT_MS);

        const modelId = data.modelId ?? data.model_id ?? data.model ?? "paddleocr-pp-ocrv5";
        const spans = (data.lines ?? [])
          .filter((l) => l.text)
          .map((l) => {
            const bb = l.bbox;
            // bbox=[x,y,w,h]; drop zero-area boxes (sidecar defaults missing
            // bbox to [0,0,0,0]).
            const bbox =
              Array.isArray(bb) &&
              bb.length === 4 &&
              bb.every((n) => typeof n === "number") &&
              (bb[2] as number) > 0 &&
              (bb[3] as number) > 0
                ? ([bb[0], bb[1], bb[2], bb[3]] as [number, number, number, number])
                : undefined;
            return { text: l.text!, confidence: l.confidence ?? 0, ...(bbox ? { bbox } : {}) };
          });
        return { spans, modelId };
      },
      catch: (err) => unavailable("jex/Ocr", err instanceof Error ? err.message : String(err)),
    }),
});

// ---------------------------------------------------------------------------
// FaceDetection
// ---------------------------------------------------------------------------

export const VisionSidecarFaceDetectionLayer = Layer.succeed(FaceDetection, {
  detect: (req: FaceDetectionRequest) =>
    Effect.tryPromise({
      try: async () => {
        const data = await sidecarPost<{
          faces?: Array<{
            bbox?: { x?: number; y?: number; w?: number; h?: number };
            embedding?: number[];
            confidence?: number;
          }>;
          modelId?: string;
          model_id?: string;
        }>("/vision/faces", { imageBase64: req.imageBase64 });

        const modelId = data.modelId ?? data.model_id ?? "arcface";
        const faces = (data.faces ?? []).map((f) => ({
          boundingBox: { x: f.bbox?.x ?? 0, y: f.bbox?.y ?? 0, width: f.bbox?.w ?? 0, height: f.bbox?.h ?? 0 },
          embedding: f.embedding ?? [],
          confidence: f.confidence ?? 0,
        }));
        return { faces, modelId };
      },
      catch: (err) => unavailable("jex/FaceDetection", err instanceof Error ? err.message : String(err)),
    }),
});

// ---------------------------------------------------------------------------
// ImageLabeling
// ---------------------------------------------------------------------------

export const VisionSidecarImageLabelingLayer = Layer.succeed(ImageLabeling, {
  label: (req: ImageLabelingRequest) =>
    Effect.tryPromise({
      try: async () => {
        const data = await sidecarPost<{
          labels?: Array<string | { label?: string; score?: number }>;
          modelId?: string;
          model_id?: string;
        }>("/vision/label", { imageBase64: req.imageBase64, topK: req.topK }, OCR_TIMEOUT_MS);

        const modelId = data.modelId ?? data.model_id ?? "vlm-label";
        const labels = (data.labels ?? []).map((item) =>
          typeof item === "string"
            ? { label: item, score: 1 }
            : { label: item.label ?? "", score: item.score ?? 1 }
        );
        return { labels, modelId };
      },
      catch: (err) => unavailable("jex/ImageLabeling", err instanceof Error ? err.message : String(err)),
    }),
});


// ---------------------------------------------------------------------------
// Face-cluster GPU neighbour query (Phase 5.x)
// ---------------------------------------------------------------------------
// The sidecar exposes a CUDA cosine-neighbour endpoint at
// `/v1/faces/cluster` that returns the edge list + per-point degree array
// DBSCAN needs without ever pulling the full O(N²) distance matrix to the
// Node side. At 20k faces this collapses minutes of single-threaded JS into a
// few seconds of GPU work, freeing the worker event loop.
//
// Returns `null` (never throws) on any failure — the caller falls back to the
// in-process DBSCAN. OPTIONAL tier: unset FONTO_VISION_URL ⇒ null.

const FACE_CLUSTER_TIMEOUT_MS = 30_000;

interface FaceClusterResponseBody {
  edges?: unknown;
  deg?: unknown;
}

export interface FaceClusterNeighbours {
  edges: [number, number][];
  deg: number[];
}

/**
 * Ask the vision sidecar for the cosine-neighbour graph over `points`. Returns
 * `null` on any error (network, HTTP 4xx/5xx, malformed body) so callers can
 * degrade to the JS path. Single retry on 5xx; 30s timeout.
 *
 * `points` is interpreted as L2-normalised 512-dim ArcFace vectors (the embed
 * pipeline guarantees unit norm). `eps` is the cosine *distance* threshold
 * (1 - cosine similarity); `minPts` is forwarded for the sidecar's optional
 * chunk-sizing heuristics but the JS side still owns cluster assignment.
 */
export async function neighborsViaGPU(
  points: number[][],
  eps: number,
  minPts: number,
): Promise<FaceClusterNeighbours | null> {
  const base = visionSidecarUrl();
  if (!base) return null;
  const url = base + "/v1/faces/cluster";

  const faces = new Array<{ id: string; vec: number[] }>(points.length);
  for (let i = 0; i < points.length; i++) {
    faces[i] = { id: String(i), vec: points[i] };
  }
  // Guard the serialisation: a face set large enough to push the JSON past
  // V8's ~512MB max string length throws a RangeError ("Invalid string
  // length"). The caller caps N well below this, but degrade to null (→ caller
  // skips / falls back) instead of throwing, so an oversized set can never
  // silently kill the whole cluster pass.
  let body: string;
  try {
    body = JSON.stringify({ faces, eps, minPts, return: "edges" });
  } catch {
    return null;
  }

  const attempt = async (): Promise<{
    ok: boolean;
    retry: boolean;
    data: FaceClusterResponseBody | null;
  }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FACE_CLUSTER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(serviceKey() ? { authorization: `Bearer ${serviceKey()}` } : {}),
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, retry: res.status >= 500 && res.status < 600, data: null };
      }
      const json = (await res.json()) as FaceClusterResponseBody;
      return { ok: true, retry: false, data: json };
    } catch {
      // Network / abort — treat like a 5xx for retry purposes.
      return { ok: false, retry: true, data: null };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await attempt();
  if (!result.ok && result.retry) {
    result = await attempt();
  }
  if (!result.ok || !result.data) return null;

  const data = result.data;
  if (!Array.isArray(data.edges) || !Array.isArray(data.deg)) return null;
  const edges: [number, number][] = [];
  for (const e of data.edges) {
    if (Array.isArray(e) && e.length >= 2 && typeof e[0] === "number" && typeof e[1] === "number") {
      edges.push([e[0] as number, e[1] as number]);
    }
  }
  const deg: number[] = new Array(points.length).fill(0);
  for (let i = 0; i < data.deg.length && i < deg.length; i++) {
    const d = (data.deg as unknown[])[i];
    if (typeof d === "number") deg[i] = d;
  }
  return { edges, deg };
}
