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

// A Takeout direct-download URL identifies the export by a UUID, not a Drive
// file ID (e.g. ...?id=8e0f24e6-…-9bed6647c0d0&i=54&user=…&rapt=…). Real Drive
// file IDs are never UUIDs, so the 8-4-4-4-12 hex shape is a reliable tell.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DriveInput =
  | { kind: "id"; fileId: string }
  // A temporary Takeout "download link" (the address behind the Takeout
  // download button / "send download link" email). It's a signed,
  // expiring googleusercontent URL — the server can't re-fetch it, so the
  // user must use "Add to Drive" or upload the downloaded .zip instead.
  | { kind: "takeout-download" }
  | { kind: "none" };

/** Classify whatever the user pasted: a usable Drive file ID, a Takeout
 *  download link we must reject with guidance, or nothing recognizable. */
export function classifyDriveInput(input: string): DriveInput {
  const s = input.trim();
  if (!s) return { kind: "none" };

  const lower = s.toLowerCase();
  const looksLikeTakeoutDownload =
    lower.includes("rapt=") ||
    lower.includes("googleusercontent.com") ||
    lower.includes("usercontent.google");

  let candidate: string | null = null;
  if (s.includes("/") || s.includes("?") || s.includes("=")) {
    for (const p of PATTERNS) {
      const m = s.match(p);
      if (m?.[1]) {
        candidate = m[1];
        break;
      }
    }
  } else if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) {
    // Bare token — Drive IDs are URL-safe and comfortably longer than 10 chars.
    candidate = s;
  }

  // A UUID is a Takeout export identifier, never a Drive file ID — reject it
  // with the takeout-download guidance rather than 404ing on Drive later.
  if (looksLikeTakeoutDownload || (candidate != null && UUID.test(candidate))) {
    return { kind: "takeout-download" };
  }
  return candidate ? { kind: "id", fileId: candidate } : { kind: "none" };
}

/** Returns the Drive file ID parsed from a link, or the input itself if it
 *  already looks like a bare ID, or null if nothing usable was found. */
export function parseDriveFileId(input: string): string | null {
  const c = classifyDriveInput(input);
  return c.kind === "id" ? c.fileId : null;
}
