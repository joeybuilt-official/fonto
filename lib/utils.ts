// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Short, human-facing name for a file's format — "DNG", "PSD", "JPEG".
 *
 * Lives here, not in lib/mime.ts, purely so client components can call it:
 * lib/mime.ts imports `file-type` at module scope, so importing anything from
 * it would pull that dependency into the browser bundle. This is presentation
 * only — the authority on what a mime type IS remains lib/mime.ts.
 *
 * Prefers the filename extension, which is what a person recognises ("CR2",
 * not "image/x-canon-cr2"), and falls back to the mime subtype with its
 * vendor prefixes stripped.
 */
export function formatLabel(mimeType: string, filename?: string): string {
  if (filename) {
    const idx = filename.lastIndexOf(".");
    if (idx >= 0 && idx < filename.length - 1) {
      return filename.slice(idx + 1).toUpperCase();
    }
  }
  const sub = mimeType.split("/")[1] ?? mimeType;
  return sub.replace(/^x-/, "").replace(/^vnd\.[^.]*\./, "").toUpperCase();
}
