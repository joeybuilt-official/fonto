// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Fonto Plexo facade — delegates HTTP to @joeybuilt/plexo-sdk and keeps
 * fonto-specific domain helpers (classifyAsset, suggestTags, describeImage)
 * which are just deploy-shaped prompts on top of `aiComplete`.
 */
import { createPlexoClient, type AiMessage } from "@joeybuilt/plexo-sdk/connect"
import { ocrImage, visionConfigured } from "@/lib/plexo-vision"
import { intelligence } from "@/lib/intelligence/client"

// Re-export the unified analyze-image client so existing import sites stay
// uniform with `lib/plexo`. The implementation lives separately so the
// rollout can be flag-gated without touching the legacy helpers below.
export {
  analyzeImageUnified,
  unifiedAnalyzeEnabled,
  type AnalyzeImageResult,
  type AnalyzeImageHints,
} from "@/lib/plexo-analyze"

const sdk = createPlexoClient({
  appId: "fonto",
  plexoUrl: process.env.PLEXO_URL ?? "",
  serviceKey: process.env.PLEXO_SERVICE_KEY ?? "",
  displayName: "Fonto",
})

export function plexoAvailable(): boolean {
  return sdk.isConfigured
}

// Process-lifetime cache for ensureWorkspace results. The Plexo workspace
// id for a (userId, email) tuple is stable — once Plexo has minted one it
// will keep returning the same id forever. Without this cache the worker
// hits Plexo's per-IP `/api/auth/*` rate limiter (10 req/min) once per
// asset processed, which manifests as `429 rate limited` failures and
// rows that stall in processing_state='captured' until a human notices.
const ensureWorkspaceCache = new Map<string, Promise<string>>()

export const plexoEnsureWorkspace = (userId: string, email?: string) => {
  const key = `${userId}\x00${email ?? ""}`
  let inflight = ensureWorkspaceCache.get(key)
  if (!inflight) {
    inflight = sdk.ensureWorkspace(userId, email).catch((err) => {
      // Drop failed lookups from the cache so the next call retries.
      ensureWorkspaceCache.delete(key)
      throw err
    })
    ensureWorkspaceCache.set(key, inflight)
  }
  return inflight
}

export const plexoPublishEvent = (
  eventType: string,
  payload: Record<string, unknown>,
  workspaceId?: string,
) => sdk.publishEvent({ eventType, payload, workspaceId })

export const plexoStoreMemory = (
  workspaceId: string,
  content: string,
  metadata?: Record<string, unknown>,
) => sdk.storeMemory(workspaceId, { content, type: "pattern", metadata })

export const plexoMemorySearch = (workspaceId: string, query: string) =>
  sdk.searchMemory(workspaceId, query)

/**
 * Plexo Vision OCR result. Preserves the legacy SDK shape ({ text, model })
 * so existing callers don't need to change. Phase 4.4 also surfaces line-
 * level results via `lines` so the worker can persist `assets.ocr_boxes`.
 */
export interface PlexoVisionOcrResult {
  text: string
  model: string
  lines: Array<{ text: string; bbox: [number, number, number, number]; confidence: number }>
}

/**
 * Runs OCR for an image. Phase 4.4 swaps the legacy LLM-based path for a
 * dedicated PaddleOCR PP-OCRv5 model served by the Plexo vision sidecar
 * (see lib/plexo-vision.ts). The LLM path is retained as a fallback when
 * OCR_LLM_FALLBACK=true: if the vision service is unreachable or returns
 * an empty result we re-attempt via sdk.visionOcr.
 *
 * Empty result vs. failure:
 *   - empty: PaddleOCR ran successfully and found no text → returns
 *     `{ text: "", lines: [], model }`. Callers should record ocrState
 *     'empty', NOT 'failed'.
 *   - failure: thrown error. Callers should record ocrState 'failed'.
 *
 * The legacy SDK signature took `(workspaceId, imageUrl)`. The workspaceId
 * is unused by PaddleOCR but is retained for back-compat with the LLM
 * fallback path.
 */
export async function plexoVisionOcr(
  workspaceId: string,
  imageUrl: string,
  lang?: string,
): Promise<PlexoVisionOcrResult | null> {
  // Primary: PaddleOCR via the dedicated vision service.
  if (visionConfigured()) {
    try {
      const result = await ocrImage(imageUrl, lang)
      const text = result.lines.map((l) => l.text).join("\n")
      return {
        text,
        model: result.modelId,
        lines: result.lines,
      }
    } catch (err) {
      console.warn("[fonto] plexo-vision OCR failed, considering LLM fallback:", err)
      if (process.env.OCR_LLM_FALLBACK !== "true") {
        throw err
      }
      // fallthrough to LLM
    }
  }

  // Fallback: legacy LLM-based OCR via Plexo Core. Only attempted if
  // OCR_LLM_FALLBACK=true or the vision service isn't configured at all
  // (preserves behaviour for deploys that never set PLEXO_VISION_URL).
  const allowFallback =
    process.env.OCR_LLM_FALLBACK === "true" || !visionConfigured()
  if (!allowFallback) return null

  const legacy = await sdk.visionOcr(workspaceId, imageUrl)
  if (!legacy) return null
  return {
    text: legacy.text ?? "",
    model: legacy.model ?? "plexo-llm-ocr",
    lines: [],
  }
}

export async function plexoAiComplete(
  workspaceId: string,
  messages: AiMessage[],
  maxTokens = 512,
): Promise<string> {
  return sdk.aiComplete(workspaceId, { messages, maxTokens })
}

// ---------------------------------------------------------------------------
// Domain helpers — deploy-shaped prompts on top of aiComplete
// ---------------------------------------------------------------------------

export const IMAGE_SUBTYPES = ["photo", "screenshot", "mockup", "logo", "icon"] as const
export const DOCUMENT_SUBTYPES = ["receipt", "contract", "letter", "report", "form", "document", "scan", "text", "code"] as const
export const ALL_SUBTYPES = [...IMAGE_SUBTYPES, ...DOCUMENT_SUBTYPES] as const
export type AssetSubtype = (typeof ALL_SUBTYPES)[number]

// Deterministic text/code classification straight from the mime type — these
// are unambiguous, so we skip the LLM round-trip. text/plain is prose ("text");
// markdown and source-code mimes are "code". Returns null for any other mime so
// the caller falls back to the LLM document classifier.
export function classifyTextCodeByMime(mimeType: string): "text" | "code" | null {
  const m = (mimeType || "").toLowerCase().split(";")[0].trim()
  if (m === "text/plain") return "text"
  if (
    m === "text/markdown" ||
    m.startsWith("text/x-") ||
    m === "application/json" ||
    m === "application/x-yaml" ||
    m === "application/xml"
  ) {
    return "code"
  }
  return null
}

export async function plexoClassifyAsset(
  workspaceId: string,
  filename: string,
  mimeType: string,
  textSnippet?: string,
): Promise<string> {
  const isImage = mimeType.startsWith("image/")
  const validForType = isImage ? IMAGE_SUBTYPES.join(", ") : DOCUMENT_SUBTYPES.join(", ")
  const hint = textSnippet ? `\nContent preview: ${textSnippet.slice(0, 300)}` : ""
  const { text } = await intelligence.complete({
    workspaceId,
    messages: [
      {
        role: "user",
        content: `Classify this ${isImage ? "image" : "document"} into exactly one category. Reply with ONE word only, no punctuation:\n${validForType}\n\nFilename: ${filename}\nMIME type: ${mimeType}${hint}`,
      },
    ],
    maxTokens: 10,
  })
  const word = text.trim().toLowerCase().replace(/[^a-z]/g, "") as AssetSubtype
  return (ALL_SUBTYPES as readonly string[]).includes(word)
    ? word
    : isImage
      ? "photo"
      : "document"
}

export async function plexoSuggestTags(
  workspaceId: string,
  filename: string,
  classification: string,
  description: string | null,
): Promise<string[]> {
  try {
    const hint = description ? `\nDescription: ${description}` : ""
    const { text } = await intelligence.complete({
      workspaceId,
      messages: [
        {
          role: "user",
          content: `Suggest 3-5 short tags for this asset. Reply with a JSON array of strings only, no explanation.\n\nFilename: ${filename}\nClassification: ${classification}${hint}`,
        },
      ],
      maxTokens: 64,
    })
    const trimmed = text.trim().replace(/^```json\s*|\s*```$/g, "")
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      return (parsed as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim().slice(0, 32))
        .filter(Boolean)
        .slice(0, 5)
    }
    return []
  } catch {
    return []
  }
}

/** Image-grounded signals threaded into `plexoDescribeImage`. Each field is
 *  collected from the actual image (vision-VLM labels, PaddleOCR text, the
 *  classifier's top-level bucket) before the description prompt runs. The
 *  legacy zero-argument call site sees an empty object and falls back to
 *  filename-only — same behaviour as the old "describe by filename" prompt. */
export interface DescribeImageContext {
  classification?: string
  labels?: string[]
  ocrText?: string | null
}

export async function plexoDescribeImage(
  workspaceId: string,
  filename: string,
  mimeType: string,
  ctx: DescribeImageContext = {},
): Promise<string> {
  const { classification, labels = [], ocrText } = ctx
  // Trim each grounding signal so the prompt fits in 120 token budget.
  const labelHint = labels.length
    ? `\nObjects/scene the vision model saw in this image: ${labels.slice(0, 12).join(", ")}.`
    : ""
  const ocrSnippet = ocrText?.trim().slice(0, 500) ?? ""
  const textHint = ocrSnippet
    ? `\nText visible in the image (verbatim from OCR):\n"""${ocrSnippet}"""`
    : ""
  const catHint = classification ? `\nCategory: ${classification}.` : ""

  // Strong prompt + grounded inputs. The old "describe an image named X"
  // prompt was filename-only and the model literally invented content — that
  // is the root cause of the AI labels being unusably generic. With labels +
  // OCR, the model has real signals to anchor to and the rules forbid the
  // filler phrases ("captures", "depicts a scene", "a photo of") it would
  // otherwise default to.
  const prompt = `Write a specific 1-2 sentence caption for an image in a personal photo library. Use the grounding signals below — they are derived from the actual image. Do not invent details that aren't supported by the signals.

Filename: ${filename}
MIME type: ${mimeType}${catHint}${labelHint}${textHint}

Rules:
- Name the subject concretely (people, objects, scene). Never write "a photo of an image" or similar.
- Include setting, time of day, mood, or a notable detail when the signals support it.
- If short text is visible (receipt total, sign, headline, document title), quote it verbatim.
- Avoid filler verbs like "captures", "showcases", "depicts a scene".
- Maximum 40 words. No leading "Caption:" or quotes.

Caption:`

  const { text } = await intelligence.complete({
    workspaceId,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 120,
  })
  // The model sometimes leaks a leading "Caption:" or wraps the answer in
  // quotes despite the prompt — strip both.
  return text
    .trim()
    .replace(/^caption[:\-—]\s*/i, "")
    .replace(/^["“'](.*)["”']$/s, "$1")
    .trim()
}

// Summarises a document into a one-line description. When `content` is
// non-empty (extracted text layer or OCR), the summary is grounded in the
// actual content; otherwise it falls back to a filename-only guess so the
// description field is never left blank for a document.
export async function plexoDescribeDocument(
  workspaceId: string,
  filename: string,
  mimeType: string,
  content: string,
): Promise<string> {
  const preview = content.trim().slice(0, 2000)
  const prompt = preview
    ? `Write a concise 1-sentence description (under 25 words) of this document named "${filename}". Base it strictly on the content below; do not invent details.\n\n${preview}`
    : `Write a brief 1-sentence description for a document named "${filename}" (type: ${mimeType}). Keep it under 20 words.`
  const { text } = await intelligence.complete({
    workspaceId,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 80,
  })
  return text.trim()
}
