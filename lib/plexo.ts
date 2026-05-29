// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
/**
 * Fonto Plexo facade — delegates HTTP to @joeybuilt/plexo-sdk and keeps
 * fonto-specific domain helpers (classifyAsset, suggestTags, describeImage)
 * which are just deploy-shaped prompts on top of `aiComplete`.
 */
import { createPlexoClient, type AiMessage } from "@joeybuilt/plexo-sdk/connect"
import { ocrImage, visionConfigured } from "@/lib/plexo-vision"

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
export const DOCUMENT_SUBTYPES = ["receipt", "contract", "letter", "report", "form", "document", "scan"] as const
export const ALL_SUBTYPES = [...IMAGE_SUBTYPES, ...DOCUMENT_SUBTYPES] as const
export type AssetSubtype = (typeof ALL_SUBTYPES)[number]

export async function plexoClassifyAsset(
  workspaceId: string,
  filename: string,
  mimeType: string,
  textSnippet?: string,
): Promise<string> {
  const isImage = mimeType.startsWith("image/")
  const validForType = isImage ? IMAGE_SUBTYPES.join(", ") : DOCUMENT_SUBTYPES.join(", ")
  const hint = textSnippet ? `\nContent preview: ${textSnippet.slice(0, 300)}` : ""
  const text = await plexoAiComplete(
    workspaceId,
    [
      {
        role: "user",
        content: `Classify this ${isImage ? "image" : "document"} into exactly one category. Reply with ONE word only, no punctuation:\n${validForType}\n\nFilename: ${filename}\nMIME type: ${mimeType}${hint}`,
      },
    ],
    10,
  )
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
    const text = await plexoAiComplete(
      workspaceId,
      [
        {
          role: "user",
          content: `Suggest 3-5 short tags for this asset. Reply with a JSON array of strings only, no explanation.\n\nFilename: ${filename}\nClassification: ${classification}${hint}`,
        },
      ],
      64,
    )
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

export async function plexoDescribeImage(
  workspaceId: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const text = await plexoAiComplete(
    workspaceId,
    [
      {
        role: "user",
        content: `Write a brief 1-sentence description for an image file named "${filename}" (type: ${mimeType}). Keep it under 20 words.`,
      },
    ],
    64,
  )
  return text.trim()
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
  const text = await plexoAiComplete(
    workspaceId,
    [{ role: "user", content: prompt }],
    80,
  )
  return text.trim()
}
