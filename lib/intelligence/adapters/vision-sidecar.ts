// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Vision sidecar adapter — implements ImageEmbedding, TextEmbedding, Ocr,
// FaceDetection, ImageLabeling by HTTP-calling FONTO_VISION_URL (or
// PLEXO_VISION_URL as a fallback during Phase 1-2 transition).

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

function sidecarUrl(): string {
  return (process.env.FONTO_VISION_URL ?? process.env.PLEXO_VISION_URL ?? "").replace(/\/+$/, "");
}

function serviceKey(): string {
  return process.env.PLEXO_SERVICE_KEY ?? "";
}

async function sidecarPost<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const base = sidecarUrl();
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
