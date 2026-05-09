/**
 * Fonto Plexo facade — delegates HTTP to @joeybuilt/plexo-sdk and keeps
 * fonto-specific domain helpers (classifyAsset, suggestTags, describeImage)
 * which are just deploy-shaped prompts on top of `aiComplete`.
 */
import { createPlexoClient, type AiMessage } from "@joeybuilt/plexo-sdk/connect"

const sdk = createPlexoClient({
  appId: "fonto",
  plexoUrl: process.env.PLEXO_URL ?? "",
  serviceKey: process.env.PLEXO_SERVICE_KEY ?? "",
  displayName: "Fonto",
})

export function plexoAvailable(): boolean {
  return sdk.isConfigured
}

export const plexoEnsureWorkspace = (userId: string, email?: string) =>
  sdk.ensureWorkspace(userId, email)

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

export const plexoVisionOcr = (workspaceId: string, imageUrl: string) =>
  sdk.visionOcr(workspaceId, imageUrl)

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
