// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo Vision client — thin HTTP wrapper around the `apps/vision` service
// in the Plexo monorepo (CLIP embeddings, RapidOCR PP-OCRv5 text detection,
// etc.). Lives separately from `lib/plexo.ts` (which is the high-level
// Plexo Core SDK facade for AI completion + memory) because the vision
// service is reachable on its own URL and uses a different auth header.
//
// Phase 4.2 may also extend this module with `embedImage()`. This file is
// additive and exposes a `visionRequest` helper for both call sites so we
// avoid duplicating the auth/timeout/error plumbing.

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  modelId: string;
}

/**
 * True if PLEXO_VISION_URL is set. Without it, callers should treat the
 * vision service as unavailable and fall back to the legacy LLM path
 * (gated on OCR_LLM_FALLBACK).
 */
export function visionConfigured(): boolean {
  return Boolean(process.env.PLEXO_VISION_URL);
}

/**
 * Shared POST helper. Sends JSON, parses JSON, throws on non-2xx.
 * Auth via `Authorization: Bearer <PLEXO_SERVICE_KEY>` (same service key
 * used elsewhere in the Plexo integration).
 */
async function visionRequest<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const base = process.env.PLEXO_VISION_URL;
  if (!base) {
    throw new Error("PLEXO_VISION_URL is not set");
  }
  const url = base.replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.PLEXO_SERVICE_KEY
          ? { authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `plexo-vision ${path} HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface OcrResponse {
  lines?: Array<{
    text?: unknown;
    bbox?: unknown;
    confidence?: unknown;
  }>;
  modelId?: unknown;
  model_id?: unknown;
  model?: unknown;
}

/**
 * Run OCR on a single image via PaddleOCR PP-OCRv5 (served by the Plexo
 * vision sidecar). Accepts either:
 *   - a Buffer (sent as base64 in the JSON body), or
 *   - a string URL (the vision service will fetch the image itself —
 *     typically a presigned R2 URL).
 *
 * Returns line-level results: text, bbox `[x, y, w, h]`, and a 0..1
 * confidence. `lines` is empty if PaddleOCR ran but found no text (a
 * legitimate result, distinct from a failure).
 */
export async function ocrImage(
  buffer: Buffer | string,
  lang?: string,
): Promise<OcrResult> {
  const body: Record<string, unknown> = {
    lang: lang ?? process.env.OCR_DEFAULT_LANG ?? "en",
  };
  if (typeof buffer === "string") {
    body.imageUrl = buffer;
  } else {
    body.imageBase64 = buffer.toString("base64");
  }

  const data = await visionRequest<OcrResponse>("/vision/ocr", body);

  const modelId =
    typeof data.modelId === "string"
      ? data.modelId
      : typeof data.model_id === "string"
        ? data.model_id
        : typeof data.model === "string"
          ? data.model
          : "paddleocr-pp-ocrv5";

  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  const lines: OcrLine[] = [];
  for (const r of rawLines) {
    const text = typeof r.text === "string" ? r.text : "";
    const conf = typeof r.confidence === "number" ? r.confidence : 0;
    const bb = r.bbox;
    let bbox: [number, number, number, number] = [0, 0, 0, 0];
    if (
      Array.isArray(bb) &&
      bb.length === 4 &&
      bb.every((n) => typeof n === "number")
    ) {
      bbox = [bb[0] as number, bb[1] as number, bb[2] as number, bb[3] as number];
    }
    if (text) lines.push({ text, bbox, confidence: conf });
  }

  return { lines, modelId };
}
