// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Deploy-shaped prompts on top of the Completion port.
//
// These are the app's own prompts for classification, description and tag
// suggestion. They used to live in a sibling-app facade module and
// ran against that app's workspace-scoped completion endpoint; they now run
// through the app-owned Completion port, with the user's own AI connection
// (or the deployment default) resolved by `intelligence.completeForUser`.
//
// Prompts stay here (configuration-ish, one home) so a model swap or a prompt
// iteration is a change in this file and nothing else.

import { intelligence } from "./client";

export const IMAGE_SUBTYPES = ["photo", "screenshot", "mockup", "logo", "icon"] as const;
export const DOCUMENT_SUBTYPES = [
  "receipt",
  "contract",
  "letter",
  "report",
  "form",
  "document",
  "scan",
  "text",
  "code",
] as const;
export const ALL_SUBTYPES = [...IMAGE_SUBTYPES, ...DOCUMENT_SUBTYPES] as const;
export type AssetSubtype = (typeof ALL_SUBTYPES)[number];

/**
 * One-word classification for an asset. Returns the mime-derived default when
 * the completion tier is unavailable or answers with an unknown word — the
 * caller's asset must never fail over a label.
 */
export async function classifyAssetWithAi(
  userId: string | null | undefined,
  filename: string,
  mimeType: string,
  textSnippet?: string,
): Promise<string> {
  const isImage = mimeType.startsWith("image/");
  const validForType = isImage ? IMAGE_SUBTYPES.join(", ") : DOCUMENT_SUBTYPES.join(", ");
  const hint = textSnippet ? `\nContent preview: ${textSnippet.slice(0, 300)}` : "";
  const { text } = await intelligence.completeForUser(userId, {
    messages: [
      {
        role: "user",
        content: `Classify this ${isImage ? "image" : "document"} into exactly one category. Reply with ONE word only, no punctuation:\n${validForType}\n\nFilename: ${filename}\nMIME type: ${mimeType}${hint}`,
      },
    ],
    maxTokens: 10,
  });
  const word = text.trim().toLowerCase().replace(/[^a-z]/g, "") as AssetSubtype;
  return (ALL_SUBTYPES as readonly string[]).includes(word)
    ? word
    : isImage
      ? "photo"
      : "document";
}

/**
 * Suggest 3-5 short tags. Returns [] on any failure — a tag suggestion is an
 * enhancement and must never throw into a pipeline.
 */
export async function suggestTagsWithAi(
  userId: string | null | undefined,
  filename: string,
  classification: string,
  description: string | null,
): Promise<string[]> {
  try {
    const hint = description ? `\nDescription: ${description}` : "";
    const { text } = await intelligence.completeForUser(userId, {
      messages: [
        {
          role: "user",
          content: `Suggest 3-5 short tags for this asset. Reply with a JSON array of strings only, no explanation.\n\nFilename: ${filename}\nClassification: ${classification}${hint}`,
        },
      ],
      maxTokens: 64,
    });
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

/** Image-grounded signals threaded into `describeImageWithAi`. Each field is
 *  collected from the actual image (vision labels, OCR text, the classifier's
 *  top-level bucket) before the description prompt runs. */
export interface DescribeImageContext {
  classification?: string;
  labels?: string[];
  ocrText?: string | null;
}

/** 1-2 sentence caption grounded in the vision signals for an image. */
export async function describeImageWithAi(
  userId: string | null | undefined,
  filename: string,
  mimeType: string,
  ctx: DescribeImageContext = {},
): Promise<string> {
  const { classification, labels = [], ocrText } = ctx;
  const labelHint = labels.length
    ? `\nObjects/scene the vision model saw in this image: ${labels.slice(0, 12).join(", ")}.`
    : "";
  const ocrSnippet = ocrText?.trim().slice(0, 500) ?? "";
  const textHint = ocrSnippet
    ? `\nText visible in the image (verbatim from OCR):\n"""${ocrSnippet}"""`
    : "";
  const catHint = classification ? `\nCategory: ${classification}.` : "";

  // Strong prompt + grounded inputs. Filename-only prompts make the model
  // invent content; with labels + OCR it has real signals to anchor to, and
  // the rules forbid the filler phrases ("captures", "depicts a scene").
  const prompt = `Write a specific 1-2 sentence caption for an image in a personal photo library. Use the grounding signals below — they are derived from the actual image. Do not invent details that aren't supported by the signals.

Filename: ${filename}
MIME type: ${mimeType}${catHint}${labelHint}${textHint}

Rules:
- Name the subject concretely (people, objects, scene). Never write "a photo of an image" or similar.
- Include setting, time of day, mood, or a notable detail when the signals support it.
- If short text is visible (receipt total, sign, headline, document title), quote it verbatim.
- Avoid filler verbs like "captures", "showcases", "depicts a scene".
- Maximum 40 words. No leading "Caption:" or quotes.

Caption:`;

  const { text } = await intelligence.completeForUser(userId, {
    messages: [{ role: "user", content: prompt }],
    maxTokens: 120,
  });
  // The model sometimes leaks a leading "Caption:" or wraps the answer in
  // quotes despite the prompt — strip both.
  return text
    .trim()
    .replace(/^caption[:\-—]\s*/i, "")
    .replace(/^["“'](.*)["”']$/s, "$1")
    .trim();
}

// Summarises a document into a one-line description. When `content` is
// non-empty (extracted text layer or OCR), the summary is grounded in the
// actual content; otherwise it falls back to a filename-only guess so the
// description field is never left blank for a document.
export async function describeDocumentWithAi(
  userId: string | null | undefined,
  filename: string,
  mimeType: string,
  content: string,
): Promise<string> {
  const preview = content.trim().slice(0, 2000);
  const prompt = preview
    ? `Write a concise 1-sentence description (under 25 words) of this document named "${filename}". Base it strictly on the content below; do not invent details.\n\n${preview}`
    : `Write a brief 1-sentence description for a document named "${filename}" (type: ${mimeType}). Keep it under 20 words.`;
  const { text } = await intelligence.completeForUser(userId, {
    messages: [{ role: "user", content: prompt }],
    maxTokens: 80,
  });
  return text.trim();
}
