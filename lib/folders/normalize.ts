// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.5 — folder-path normalisation.
//
// `directoryPath` on an asset is a STRING prefix (Immich-style), not a foreign
// key to a folders table. Folders are virtual — they're just GROUP BY prefixes
// over `assets.directory_path`. This helper enforces the canonical shape every
// upload site has to write so the listing query
// (`split_part(directory_path FROM len(prefix)+2, '/', 1)`) actually works.
//
// Canonical shape: `/Photos/2024/Iceland`
//   - Single leading `/`
//   - No trailing `/`
//   - No `..` segments (no path traversal)
//   - Forward slashes only (we collapse `\` from Windows clients)
//   - <= 1024 chars
//
// Returns `null` for empty/invalid input. Never throws — uploads that pass a
// bogus path simply land at the workspace root.

const MAX_DIRECTORY_PATH_LENGTH = 1024;

export interface NormalizeOptions {
  /**
   * If provided, and the last segment of the input path matches this filename
   * exactly, strip it. Lets clients pass the full file path (relative or not)
   * without us materialising the file as a folder. e.g.
   *   input  = "/Photos/2024/IMG_0001.jpg", filename = "IMG_0001.jpg"
   *   output = "/Photos/2024"
   */
  filename?: string;
}

export function normalizeDirectoryPath(
  input: unknown,
  options: NormalizeOptions = {}
): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (value.length === 0) return null;

  // Windows clients sometimes send back-slashes; normalise first so every
  // downstream check operates on POSIX shape.
  value = value.replace(/\\/g, "/");

  // Collapse runs of consecutive slashes (`a//b///c` -> `a/b/c`).
  value = value.replace(/\/{2,}/g, "/");

  // Reject any `..` segment outright. We don't try to resolve them — a path
  // with `..` is almost always either a client bug or a traversal attempt.
  const segments = value.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => s === ".")) {
    // Drop bare `.` segments while we're here — harmless but ugly.
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i] === ".") segments.splice(i, 1);
    }
  }

  if (segments.length === 0) return null;

  // If the last segment matches the upload filename, treat the input as a
  // *file* path and strip the basename. The remaining segments are the dir.
  if (options.filename && segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last === options.filename) segments.pop();
  }

  if (segments.length === 0) return null;

  const normalised = "/" + segments.join("/");
  if (normalised.length > MAX_DIRECTORY_PATH_LENGTH) return null;

  return normalised;
}
