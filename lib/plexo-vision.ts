// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo Vision client — thin HTTP wrapper around the `apps/vision` service
// in the Plexo monorepo (Phase 4.1). Three endpoint families today:
//
//   POST /vision/clip/image  { image }  → { vector, modelId }
//   POST /vision/clip/text   { text }   → { vector, modelId }
//   POST /vision/ocr         { image | imageUrl, lang? } → { lines[], modelId }
//
// (Face detect/embed routes exist on the service side but no client yet —
//  Phase 5.)
//
// Lives separately from `lib/plexo.ts` (the Plexo Core SDK facade for
// completion + memory) because the vision service is reachable on its own
// URL and uses the same shared `PLEXO_SERVICE_KEY` as Plexo Core but as a
// distinct deployable.
//
// AGPL note: OpenCLIP weights are MIT, PaddleOCR PP-OCRv5 is Apache 2.0 —
// shipping them inside our own ONNX runtime is fine with an AGPL app.

const DEFAULT_TIMEOUT_MS = 15_000;
// OCR can be backed by a CPU-only VLM (Ollama Qwen2.5-VL) which routinely
// takes 10–30 s/image — earlier 30 s cap was tuned for PaddleOCR's <2 s
// per call and aborted every VLM run. 120 s gives slow images headroom
// without pinning a worker forever; the per-asset BullMQ retry policy
// handles genuinely stuck calls.
const OCR_TIMEOUT_MS = 300_000;

/**
 * Stable CLIP model identifier — matches the `modelId` field returned by
 * plexo-vision (`apps/vision/src/models/clip.ts`). Used by the zero-shot
 * classify cache (`lib/classify/vectors.ts`) to invalidate its on-disk
 * taxonomy embeddings whenever the embedding-space owner changes models.
 * Keep in sync with plexo's `DEFAULT_CLIP_MODEL` constant.
 */
export const EMBEDDING_MODEL_ID = "openclip-vit-b-32";

let cachedModelId: string | null = null;

function visionUrl(): string {
  return process.env.PLEXO_VISION_URL ?? "http://plexo-vision:7000";
}

function serviceKey(): string {
  return process.env.PLEXO_SERVICE_KEY ?? "";
}

/**
 * True iff PLEXO_VISION_URL is set. Callers that need to degrade gracefully
 * branch on this before touching any of the embed/ocr functions. Note we do
 * NOT require PLEXO_SERVICE_KEY here — the OCR path may be exercised on dev
 * instances without auth; the auth header is omitted when the key is unset.
 */
export function visionConfigured(): boolean {
  return Boolean(process.env.PLEXO_VISION_URL);
}

/** Last-seen model id from any vision call. */
export function lastSeenModelId(): string | null {
  return cachedModelId;
}

/** Shared POST helper. Generic over the response shape. */
async function visionRequest<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
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
        accept: "application/json",
        ...(serviceKey() ? { authorization: `Bearer ${serviceKey()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `plexo-vision ${path} HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- CLIP embeddings (Phase 4.2) -----------------------------------------

export interface EmbedResult {
  vector: number[];
  modelId: string;
}

interface EmbedResponseBody {
  vector?: unknown;
  modelId?: unknown;
  model_id?: unknown;
}

function parseEmbedBody(raw: EmbedResponseBody): EmbedResult {
  const vec = raw.vector;
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
    typeof raw.modelId === "string"
      ? raw.modelId
      : typeof raw.model_id === "string"
        ? raw.model_id
        : "unknown";
  cachedModelId = modelId;
  return { vector: numeric, modelId };
}

/**
 * Embed an image. Accepts either a `Buffer` (raw image bytes — base64'd
 * before send) or a `string` (already base64-encoded, no data: prefix).
 */
export async function embedImage(buffer: Buffer | string): Promise<EmbedResult> {
  const image = typeof buffer === "string" ? buffer : buffer.toString("base64");
  return parseEmbedBody(
    await visionRequest<EmbedResponseBody>("/vision/clip/image", { image })
  );
}

/**
 * Embed a free-text query for CLIP text-to-image retrieval. The returned
 * vector shares a unit-norm latent space with `embedImage()` output.
 */
export async function embedText(text: string): Promise<EmbedResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("vision: empty text payload");
  }
  return parseEmbedBody(
    await visionRequest<EmbedResponseBody>("/vision/clip/text", { text: trimmed })
  );
}

// --- OCR (Phase 4.4 — PaddleOCR PP-OCRv5) --------------------------------

export interface OcrLine {
  text: string;
  bbox: [number, number, number, number];
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  modelId: string;
}

interface OcrResponseBody {
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
 * Run OCR on a single image via PaddleOCR PP-OCRv5. Accepts either a Buffer
 * (sent as base64) or a string URL (the vision service fetches it itself —
 * typically a presigned R2 URL).
 *
 * Returns line-level results: text + bbox `[x, y, w, h]` + 0..1 confidence.
 * `lines` is empty when PaddleOCR ran but found no text (a legitimate
 * result, distinct from a failure throw).
 */
export async function ocrImage(
  buffer: Buffer | string,
  lang?: string
): Promise<OcrResult> {
  const body: Record<string, unknown> = {
    lang: lang ?? process.env.OCR_DEFAULT_LANG ?? "en",
  };
  if (typeof buffer === "string") {
    body.imageUrl = buffer;
  } else {
    body.imageBase64 = buffer.toString("base64");
  }

  const data = await visionRequest<OcrResponseBody>(
    "/vision/ocr",
    body,
    OCR_TIMEOUT_MS
  );

  const modelId =
    typeof data.modelId === "string"
      ? data.modelId
      : typeof data.model_id === "string"
        ? data.model_id
        : typeof data.model === "string"
          ? data.model
          : "paddleocr-pp-ocrv5";
  cachedModelId = modelId;

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

// --- Phase 4.5 compatibility alias ---------------------------------------

/**
 * Alias for `visionConfigured`. Phase 4.5's dedup code prefers this longer
 * name; both point at the same env probe.
 */
export const visionServiceConfigured = visionConfigured;
