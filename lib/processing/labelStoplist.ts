// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Stop-list for auto-generated "Things" labels (Explore > Things).
//
// The vision labeller returns a lot of noise that is useless as a discovery
// surface: anatomy fragments ("Forehead", "Jaw"), abstract visual properties
// ("Pattern", "Repetition", "Tints and shades"), and meta terms ("Photograph",
// "Screenshot"). These flood Things and bury the meaningful nouns (Cow,
// Mountain, Vehicle). We drop them both at tag time (processAsset) and in a
// one-time curation pass over existing tags.
//
// Keep this a DENY list, not an allow list — an allow list would silently
// drop new, legitimately useful labels the model learns to emit.

const RAW_STOPLIST = [
  // ── Anatomy / body parts (faces dominate a personal library) ──
  "forehead", "chin", "jaw", "cheek", "cheeks", "eyebrow", "eyebrows",
  "eyelash", "eyelashes", "nose", "nostril", "lip", "lips", "mouth", "tooth",
  "teeth", "skin", "hair", "facial hair", "beard", "moustache", "mustache",
  "head", "face", "ear", "ears", "eye", "eyes", "iris", "pupil", "neck",
  "throat", "shoulder", "shoulders", "arm", "elbow", "hand", "hands", "finger",
  "fingers", "thumb", "wrist", "knuckle", "leg", "knee", "foot", "feet", "toe",
  "human body", "human leg", "flesh", "organ", "jheek", "temple", "forehead",
  "facial expression", "smile", "laugh", "wrinkle",

  // ── Abstract visual properties / Google-Vision noise ──
  "pattern", "repetition", "symmetry", "texture", "material", "material property",
  "design", "art", "modern art", "visual arts", "still life photography",
  "close-up", "closeup", "macro photography", "macro", "colorfulness",
  "tints and shades", "monochrome", "monochrome photography", "black and white",
  "black-and-white", "line", "lines", "rectangle", "circle", "triangle",
  "square", "shape", "geometry", "angle", "parallel", "curve", "font",
  "typography", "calligraphy", "handwriting", "number", "symbol", "graphics",
  "illustration", "drawing", "sketch", "painting", "image", "picture", "photo",
  "photograph", "photography", "photographic paper", "stock photography",
  "snapshot", "screenshot", "selfie", "portrait", "portraits", "color",
  "colour", "light", "lighting", "shadow", "reflection", "blur", "darkness",
  "night", "atmosphere", "space", "sky photography", "azure", "electric blue",
  "magenta", "peach", "amber", "beige", "tan", "brown", "grey", "gray",
  "white", "black", "composite material", "rectangle", "gesture", "sleeve",

  // ── Meta / generic / non-thing ──
  "person", "people", "human", "man", "woman", "boy", "girl", "child",
  "adult", "male", "female", "text", "document", "paper", "note", "sign",
  "signage", "poster", "brand", "logo", "label", "screenshot", "no", "yes",
  "event", "fun", "leisure", "recreation", "happy", "happiness", "smile",
  "thumbnail", "collage", "frame", "border",
];

// Normalised set for O(1) lookups.
const STOPLIST = new Set(RAW_STOPLIST.map((s) => s.toLowerCase().trim()));

// Substring fragments that make any containing label junk (catches the long
// Google-Vision compounds like "Still life photography", "Macro photography").
const STOP_SUBSTRINGS = [
  "photography",
  "still life",
  "close-up",
  "tints and shades",
  "human body",
  "facial",
];

/**
 * True when a label is noise that should not become a Thing. Case-insensitive.
 */
export function isJunkLabel(name: string): boolean {
  const key = name.toLowerCase().trim();
  if (key.length === 0) return true;
  if (STOPLIST.has(key)) return true;
  for (const frag of STOP_SUBSTRINGS) {
    if (key.includes(frag)) return true;
  }
  return false;
}

/** The flat deny list — used by the one-time curation SQL to delete matches. */
export function stoplistTerms(): string[] {
  return [...STOPLIST];
}
