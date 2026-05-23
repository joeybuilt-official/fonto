// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4.6 — Zero-shot CLIP classification taxonomy.
//
// A static three-tier taxonomy: top-level → sub-level → tag-suggestions.
// Each leaf carries a short natural-language prompt that gets embedded as
// text via the Plexo vision service at boot. Classification is then a
// straight cosine-similarity argmax over the image's CLIP embedding.
//
// Top-level keys are intentionally the same strings the rest of the
// codebase already recognises in `assets.classification`. This keeps every
// downstream consumer (smart-collection facets, document-event triggers,
// receipt detection) working without churn.
//
// Designed to be cheap to extend in a follow-up PR — drop more `SubCategory`
// entries (or whole `TopCategory` blocks) and the classifier picks them up
// after a cache-bust (delete `~/.fonto/classify-vectors.json`).

/**
 * One sub-category of a top-level class. The `prompt` is what we feed
 * to CLIP's text encoder. The `tags` are the tag-name strings we suggest
 * via the existing ai-suggested-tags path (created in `tags` if missing).
 */
export interface SubCategory {
  /** Slug-cased label, persisted into `assets.sub_classification`. */
  key: string;
  /** Natural-language CLIP prompt — keep it short and concrete. */
  prompt: string;
  /** Tag-suggestion names to apply on a confident CLIP hit. */
  tags: string[];
}

/**
 * One top-level class. The `key` doubles as the value written to
 * `assets.classification`, so it must match what the rest of the
 * codebase (event triggers, smart-collection chips) already expects.
 */
export interface TopCategory {
  key: string;
  prompt: string;
  /** Sub-categories live here. Empty array = no sub-classification. */
  subs: SubCategory[];
}

export const TAXONOMY: readonly TopCategory[] = [
  {
    key: "photo",
    prompt: "a photograph",
    subs: [
      { key: "portrait", prompt: "a portrait photograph of a person", tags: ["Portraits"] },
      { key: "landscape", prompt: "a landscape photograph of scenery", tags: ["Landscape"] },
      { key: "food", prompt: "a photograph of food on a plate", tags: ["Food"] },
      { key: "pets", prompt: "a photograph of a pet animal", tags: ["Pets", "Animals"] },
      { key: "sports", prompt: "a photograph of a sports event", tags: ["Sports"] },
      { key: "architecture", prompt: "a photograph of a building or architecture", tags: ["Architecture"] },
      { key: "nature", prompt: "a photograph of nature, plants, or wildlife", tags: ["Nature"] },
      { key: "event", prompt: "a photograph of people at a social event", tags: ["Events"] },
      { key: "selfie", prompt: "a selfie photograph taken at arm's length", tags: ["Selfies"] },
    ],
  },
  {
    key: "document",
    prompt: "a scanned document or page of text",
    subs: [
      { key: "letter", prompt: "a scanned letter or correspondence", tags: ["Letters"] },
      { key: "contract", prompt: "a scanned legal contract", tags: ["Contracts"] },
      { key: "form", prompt: "a scanned form to be filled out", tags: ["Forms"] },
      { key: "report", prompt: "a scanned report or article", tags: ["Reports"] },
    ],
  },
  {
    key: "screenshot",
    prompt: "a screenshot from a computer or phone",
    subs: [
      { key: "chat", prompt: "a screenshot of a chat conversation", tags: ["Chats"] },
      { key: "webpage", prompt: "a screenshot of a web page", tags: ["Web"] },
      { key: "app-ui", prompt: "a screenshot of a mobile or desktop app interface", tags: ["UI"] },
    ],
  },
  {
    key: "meme",
    prompt: "an internet meme image with overlaid text",
    subs: [],
  },
  {
    key: "art",
    prompt: "a painting, illustration, or piece of digital art",
    subs: [
      { key: "painting", prompt: "a painting on canvas", tags: ["Paintings"] },
      { key: "illustration", prompt: "a digital illustration or drawing", tags: ["Illustrations"] },
      { key: "sculpture", prompt: "a photograph of a sculpture", tags: ["Sculpture"] },
    ],
  },
  // NOTE: kept as a top-level (rather than a `screenshot` sub) so the
  // existing `classification === "receipt"` event-trigger code path
  // doesn't need a special-case. Same logic for `id-card`.
  {
    key: "screenshot-receipt",
    prompt: "a photograph or scan of a paper receipt",
    subs: [],
  },
  {
    key: "id-card",
    prompt: "a photograph of an identification card or driver's license",
    subs: [],
  },
  {
    key: "cover-art",
    prompt: "album cover art or book cover art",
    subs: [],
  },
  {
    key: "whiteboard",
    prompt: "a photograph of a whiteboard with writing on it",
    subs: [],
  },
] as const;

/**
 * Map our top-level taxonomy key onto the legacy `classification` string
 * the rest of the codebase recognises. For most keys it's the identity;
 * for the special-case ones we collapse onto the existing legacy values
 * so document-event triggers etc. keep firing.
 */
export function legacyClassificationFor(topKey: string): string {
  switch (topKey) {
    case "screenshot-receipt":
      return "receipt";
    case "id-card":
      return "document";
    case "cover-art":
      return "photo";
    case "whiteboard":
      return "photo";
    case "meme":
      return "photo";
    case "art":
      return "photo";
    default:
      return topKey;
  }
}

/** Flat list of every prompt we need to embed at boot. */
export function allPrompts(): { id: string; prompt: string }[] {
  const out: { id: string; prompt: string }[] = [];
  for (const top of TAXONOMY) {
    out.push({ id: `top:${top.key}`, prompt: top.prompt });
    for (const sub of top.subs) {
      out.push({ id: `sub:${top.key}:${sub.key}`, prompt: sub.prompt });
    }
  }
  return out;
}

/** Total prompt count. Surfaced for logs/metrics + the CHANGES.md report. */
export const TAXONOMY_PROMPT_COUNT = allPrompts().length;
