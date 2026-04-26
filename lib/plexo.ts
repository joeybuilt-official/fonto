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
