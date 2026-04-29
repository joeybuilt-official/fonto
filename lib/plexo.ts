const PLEXO_URL = process.env.PLEXO_URL?.replace(/\/$/, "") ?? "";
const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? "";

export function plexoAvailable(): boolean {
  return Boolean(PLEXO_URL && PLEXO_SERVICE_KEY);
}

export async function plexoEnsureWorkspace(userId: string, email?: string): Promise<string> {
  const res = await fetch(`${PLEXO_URL}/api/v1/auth/workspace/ensure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
      "X-App-Id": "fonto",
      "X-User-Id": userId,
    },
    body: JSON.stringify({ userId, name: "Fonto", email }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`workspace/ensure failed: ${res.status}`);
  const data = (await res.json()) as { workspaceId: string };
  return data.workspaceId;
}

export async function plexoAiComplete(
  plexoWorkspaceId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 512
): Promise<string> {
  const res = await fetch(`${PLEXO_URL}/api/v1/ai/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
      "X-App-Id": "fonto",
    },
    body: JSON.stringify({ workspaceId: plexoWorkspaceId, messages, maxTokens }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`ai/complete failed: ${res.status}`);
  const data = (await res.json()) as { text: string };
  return data.text;
}

export const IMAGE_SUBTYPES = ["photo", "screenshot", "mockup", "logo", "icon"] as const;
export const DOCUMENT_SUBTYPES = ["receipt", "contract", "letter", "report", "form", "document", "scan"] as const;
export const ALL_SUBTYPES = [...IMAGE_SUBTYPES, ...DOCUMENT_SUBTYPES] as const;
export type AssetSubtype = typeof ALL_SUBTYPES[number];

export async function plexoClassifyAsset(
  plexoWorkspaceId: string,
  filename: string,
  mimeType: string,
  textSnippet?: string
): Promise<string> {
  const isImage = mimeType.startsWith("image/");
  const validForType = isImage
    ? IMAGE_SUBTYPES.join(", ")
    : DOCUMENT_SUBTYPES.join(", ");
  const hint = textSnippet ? `\nContent preview: ${textSnippet.slice(0, 300)}` : "";
  const text = await plexoAiComplete(
    plexoWorkspaceId,
    [
      {
        role: "user",
        content: `Classify this ${isImage ? "image" : "document"} into exactly one category. Reply with ONE word only, no punctuation:\n${validForType}\n\nFilename: ${filename}\nMIME type: ${mimeType}${hint}`,
      },
    ],
    10
  );
  const word = text.trim().toLowerCase().replace(/[^a-z]/g, "") as AssetSubtype;
  return (ALL_SUBTYPES as readonly string[]).includes(word)
    ? word
    : isImage ? "photo" : "document";
}

export async function plexoPublishEvent(
  eventType: string,
  payload: Record<string, unknown>,
  workspaceId?: string
): Promise<void> {
  if (!plexoAvailable()) return;
  try {
    await fetch(`${PLEXO_URL}/api/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        "X-App-Id": "fonto",
      },
      body: JSON.stringify({ eventType, payload, workspaceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal: events are best-effort
  }
}

export async function plexoStoreMemory(
  plexoWorkspaceId: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!plexoAvailable()) return;
  try {
    await fetch(`${PLEXO_URL}/api/memory/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        "X-App-Id": "fonto",
      },
      body: JSON.stringify({
        workspaceId: plexoWorkspaceId,
        content,
        type: "pattern",
        metadata,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Non-fatal
  }
}

export async function plexoSuggestTags(
  plexoWorkspaceId: string,
  filename: string,
  classification: string,
  description: string | null
): Promise<string[]> {
  try {
    const hint = description ? `\nDescription: ${description}` : "";
    const text = await plexoAiComplete(
      plexoWorkspaceId,
      [
        {
          role: "user",
          content: `Suggest 3-5 short tags for this asset. Reply with a JSON array of strings only, no explanation.\n\nFilename: ${filename}\nClassification: ${classification}${hint}`,
        },
      ],
      64
    );
    const trimmed = text.trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return (parsed as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim().slice(0, 32))
        .filter(Boolean)
        .slice(0, 5);
    }
    return [];
  } catch {
    return [];
  }
}

export async function plexoMemorySearch(
  plexoWorkspaceId: string,
  query: string
): Promise<Array<{ id: string; score?: number }>> {
  if (!plexoAvailable()) return [];
  try {
    const PLEXO_URL = process.env.PLEXO_URL ?? "";
    const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? "";
    const res = await fetch(
      `${PLEXO_URL}/api/memory/search?workspaceId=${encodeURIComponent(plexoWorkspaceId)}&q=${encodeURIComponent(query)}&limit=20`,
      {
        headers: { Authorization: `Bearer ${PLEXO_SERVICE_KEY}`, "X-App-Id": "fonto" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json() as { results?: Array<{ id: string; score?: number }> };
    return data.results ?? [];
  } catch {
    return [];
  }
}

export async function plexoDescribeImage(
  plexoWorkspaceId: string,
  filename: string,
  mimeType: string
): Promise<string> {
  const text = await plexoAiComplete(
    plexoWorkspaceId,
    [
      {
        role: "user",
        content: `Write a brief 1-sentence description for an image file named "${filename}" (type: ${mimeType}). Keep it under 20 words.`,
      },
    ],
    64
  );
  return text.trim();
}

/**
 * OCR an image via Plexo's vision endpoint. The image must be reachable
 * from Plexo (signed R2 URL works). Returns the extracted text plus a
 * coarse confidence proxy. Resolves null on any failure (so the caller
 * can mark the asset as `failed` and retry on the next cron pass).
 */
export async function plexoVisionOcr(
  plexoWorkspaceId: string,
  imageUrl: string
): Promise<{ text: string; confidence: number; model: string } | null> {
  if (!plexoAvailable()) return null;
  try {
    const res = await fetch(`${PLEXO_URL}/api/v1/vision/ocr`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        "X-App-Id": "fonto",
      },
      body: JSON.stringify({ workspaceId: plexoWorkspaceId, imageUrl }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      text?: string;
      confidence?: number;
      model?: string;
    };
    return {
      text: data.text ?? "",
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      model: data.model ?? "unknown",
    };
  } catch {
    return null;
  }
}
