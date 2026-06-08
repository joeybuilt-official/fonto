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
//
// ADR 0001 (2026-06-08) — Intent-driven taxonomy: prompt rewrites applied
// per §5; subs added per §3 (travel, whiteboard, note-page, error-dialog,
// receipt-screenshot, wallpaper, diagram).

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
    // ADR 0001 §5 — anchor to "lived scene" so phone-photo-of-paper doesn't
    // beat the document prompt on cosine. The old "a photograph" was too
    // generic; CLIP picked it for receipts held in hand.
    prompt:
      "a candid photograph of a lived scene with people, places, food, or animals",
    subs: [
      { key: "portrait", prompt: "a portrait photograph of a person", tags: ["Portraits"] },
      { key: "landscape", prompt: "a landscape photograph of scenery", tags: ["Landscape"] },
      { key: "food", prompt: "a photograph of food on a plate", tags: ["Food"] },
      { key: "pets", prompt: "a photograph of a pet animal", tags: ["Pets", "Animals"] },
      { key: "sports", prompt: "a photograph of a sports event", tags: ["Sports"] },
      // ADR 0001 §5 — explicit "main subject" framing catches storefront-w/-logo
      // as architecture (→ moment) instead of letting `logo` win.
      { key: "architecture", prompt: "a photograph of a building, storefront, or piece of street architecture as the main subject", tags: ["Architecture"] },
      { key: "nature", prompt: "a photograph of nature, plants, or wildlife", tags: ["Nature"] },
      { key: "event", prompt: "a photograph of people at a social event", tags: ["Events"] },
      { key: "selfie", prompt: "a selfie photograph taken at arm's length", tags: ["Selfies"] },
      // ADR 0001 §3 + §5 — gives moments a home for sign-in-scene + landmark
      // travel photos. Overlap with architecture mitigated by "with people or
      // vehicles" framing.
      { key: "travel", prompt: "a travel photograph showing a landmark, sign, or street scene with people or vehicles", tags: ["Travel"] },
    ],
  },
  {
    key: "document",
    // Phase 7.2 — phone shots of paper rarely look "scanned" (angled, on a
    // table, with shadows and ambient color). Broaden the prompt to cover
    // the phone-photo case so receipts / paper notes / packing slips don't
    // beat the "photograph" prompt on cosine.
    prompt:
      "a photograph or scan of a paper document with printed or handwritten text",
    subs: [
      { key: "letter", prompt: "a photograph or scan of a letter or piece of correspondence", tags: ["Letters"] },
      { key: "contract", prompt: "a photograph or scan of a legal contract", tags: ["Contracts"] },
      { key: "form", prompt: "a photograph or scan of a form to be filled out", tags: ["Forms"] },
      { key: "report", prompt: "a photograph or scan of a printed report or article", tags: ["Reports"] },
      // ADR 0001 §5 — "captured close-up" gives CLIP a framing anchor distinct
      // from "scene with paper in it".
      { key: "handwritten-note", prompt: "a piece of paper or notebook page filled with handwritten text, captured close-up", tags: ["Notes"] },
      { key: "packing-slip", prompt: "a photograph of a packing slip or shipping label with a barcode and addresses", tags: ["Shipping"] },
      // Task 20 — moved-down doc subs (were top-level keys in v1). Keeping
      // them as document subs collapses them to classification='document' via
      // legacyClassificationFor, while still distinguishing them in CLIP and
      // letting the sub_classification carry the specific kind for UI.
      { key: "receipt", prompt: "a photograph or scan of a paper receipt showing itemized prices and a total amount", tags: ["Receipts"] },
      { key: "invoice", prompt: "a photograph or scan of an invoice or bill", tags: ["Invoices"] },
      { key: "statement", prompt: "a photograph or scan of a bank or utility statement", tags: ["Statements"] },
      { key: "tax-form", prompt: "a photograph or scan of a tax form (W-2, 1099, 1040, etc.)", tags: ["Tax"] },
      { key: "ticket", prompt: "a photograph or scan of a paper ticket, boarding pass, or event admission", tags: ["Tickets"] },
      { key: "certificate", prompt: "a photograph or scan of a certificate, diploma, or membership card", tags: ["Certificates"] },
      { key: "card", prompt: "a photograph or scan of a greeting card, postcard, or business card", tags: ["Cards"] },
      // ADR 0001 §5 — separates menu-as-document from menu-glimpsed-in-restaurant-scene.
      { key: "menu", prompt: "a photograph of a printed menu held flat or on a table, with food or drink listings dominating the frame", tags: ["Menus"] },
      { key: "id-card", prompt: "a photograph or scan of a driver's license, ID card, or passport page", tags: ["ID"] },
      // ADR 0001 §3 — whiteboard is now a document sub (was top-level). Also
      // present as a top-level key below for back-compat w/ stale CLIP vector
      // caches; legacyClassificationFor collapses that to "document" too.
      { key: "whiteboard", prompt: "a whiteboard or chalkboard filled with diagrams or handwriting, photographed flat-on", tags: ["Whiteboards"] },
      // ADR 0001 §3 — photographed book/notebook page, distinct from
      // handwritten-note (loose paper). Sign-as-subject (>70% of frame) lands
      // here too per §3 resolution.
      { key: "note-page", prompt: "a photograph of a book page or notebook page filled with printed text, captured close-up and filling the frame", tags: ["Notes"] },
    ],
  },
  {
    key: "screenshot",
    // ADR 0001 §5 — "app chrome / status bar" are pixel features CLIP grounds
    // in better than the generic "from a computer or phone" framing.
    prompt:
      "a screenshot of a phone or computer screen showing app chrome, status bar, or UI elements",
    subs: [
      { key: "chat", prompt: "a screenshot of a chat conversation", tags: ["Chats"] },
      { key: "webpage", prompt: "a screenshot of a web page", tags: ["Web"] },
      { key: "app-ui", prompt: "a screenshot of a mobile or desktop app interface", tags: ["UI"] },
      // ADR 0001 §3 — new screenshot subs.
      { key: "error-dialog", prompt: "a screenshot of an error dialog or modal", tags: ["Errors"] },
      // ADR 0001 §3 — digital receipts (Apple Pay / Venmo / airline confirms)
      // are screenshots, not documents. Legacy top-level `screenshot-receipt`
      // collapses here via legacyClassificationFor below.
      { key: "receipt-screenshot", prompt: "a screenshot of a digital receipt or payment confirmation from an app", tags: ["Receipts"] },
    ],
  },
  // Task 20 — graphics top-level keys. CLIP needs distinct prompts to tell
  // logos / mockups / icons / stickers / clipart apart from photos and from
  // each other; they all collapse to kind='graphics' via deriveKind.
  {
    key: "logo",
    // ADR 0001 §5 — "rendered as a flat graphic ... not photographed" blocks
    // photographed storefront logos from beating moment.
    prompt:
      "a brand logo or wordmark rendered as a flat graphic on a solid or transparent background, not photographed",
    subs: [],
  },
  {
    key: "mockup",
    prompt: "a product mockup or UI design mockup rendered on a plain background",
    subs: [],
  },
  {
    key: "icon",
    prompt: "a single app icon, favicon, or small UI glyph",
    subs: [],
  },
  {
    key: "sticker",
    prompt: "a chat sticker or cartoon emoji-style image on a transparent or solid background",
    subs: [],
  },
  {
    key: "clipart",
    prompt: "a piece of clip art or generic stock illustration",
    subs: [],
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
  {
    key: "cover-art",
    prompt: "album cover art or book cover art",
    subs: [],
  },
  // ADR 0001 §3 — new graphics subs. Wallpaper = downloaded backgrounds (no
  // EXIF → graphics via deriveKind rule 6). Diagram = designed diagrams (NOT
  // whiteboard photos — those are document/whiteboard).
  {
    key: "wallpaper",
    prompt: "a downloaded desktop or phone wallpaper background, designed not photographed",
    subs: [],
  },
  {
    key: "diagram",
    prompt: "a designed diagram, flowchart, or schematic rendered as a flat graphic",
    subs: [],
  },
  {
    key: "whiteboard",
    // ADR 0001 §5 — "photographed flat-on" separates whiteboard-as-document
    // from whiteboard-as-office-scene. Top-level retained for back-compat with
    // stale CLIP caches; legacyClassificationFor now collapses to "document".
    prompt:
      "a whiteboard or chalkboard filled with diagrams or handwriting, photographed flat-on",
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
    // Legacy top-level keys removed in Task 20 — kept here as a safety net
    // in case a stale CLIP vector cache resurrects them before the rebuild.
    // ADR 0001 §3 — the new screenshot/receipt-screenshot sub takes over for
    // digital receipts going forward; this legacy mapping stays for any rows
    // still carrying the old top-level value.
    case "screenshot-receipt":
      return "receipt";
    case "id-card":
      return "document";
    // Task 20 — graphics top-level keys keep their own classification value
    // (identity); kind.ts collapses them all to kind='graphics'.
    case "logo":
    case "mockup":
    case "icon":
    case "sticker":
    case "clipart":
    case "meme":
    case "art":
    case "cover-art":
    case "wallpaper":
    case "diagram":
      return topKey;
    // ADR 0001 §3 — whiteboard now collapses to document (was "photo" in
    // Task 20). Operator's north star: content-preservation intent wins.
    case "whiteboard":
      return "document";
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
