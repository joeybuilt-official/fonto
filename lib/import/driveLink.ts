// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Extract a Google Drive file ID from whatever the user pastes — a full Drive
// share/preview link, a `uc?export=download` link, an `open?id=` link, or a
// bare file ID. Used by the Imports UI (client) and the import API (server)
// so a pasted link works end-to-end without the user hunting for the raw ID.
//
// NOTE: a Google Takeout "email me a download link" URL is a temporary signed
// googleusercontent link, NOT a Drive file — it can't be re-fetched
// server-side. Only the "export to Drive" path yields an importable file, and
// those links all carry a Drive file ID matched below.

const ID = "([a-zA-Z0-9_-]+)";

const PATTERNS: RegExp[] = [
  new RegExp(`/file/d/${ID}`), // .../file/d/<id>/view
  new RegExp(`/d/${ID}`), // .../d/<id>
  new RegExp(`[?&]id=${ID}`), // ...open?id=<id> / uc?id=<id>
];

/** Returns the Drive file ID parsed from a link, or the input itself if it
 *  already looks like a bare ID, or null if nothing usable was found. */
export function parseDriveFileId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  if (s.includes("/") || s.includes("?") || s.includes("=")) {
    for (const p of PATTERNS) {
      const m = s.match(p);
      if (m?.[1]) return m[1];
    }
    return null; // looked like a URL but no id found
  }

  // Bare token — Drive IDs are URL-safe and comfortably longer than 10 chars.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}
