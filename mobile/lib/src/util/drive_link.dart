// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Extract a Google Drive file ID from a pasted Drive link (or a bare ID).
// Mirrors lib/import/driveLink.ts on the web. A Takeout "email download link"
// is a temporary googleusercontent URL (not a Drive file); only the
// "export to Drive" links carry an ID and are importable server-side.

final List<RegExp> _patterns = [
  RegExp(r"/file/d/([a-zA-Z0-9_-]+)"),
  RegExp(r"/d/([a-zA-Z0-9_-]+)"),
  RegExp(r"[?&]id=([a-zA-Z0-9_-]+)"),
];

final RegExp _bareId = RegExp(r"^[a-zA-Z0-9_-]{10,}$");

/// Returns the Drive file ID parsed from [input], or null if none found.
String? parseDriveFileId(String input) {
  final s = input.trim();
  if (s.isEmpty) return null;

  if (s.contains("/") || s.contains("?") || s.contains("=")) {
    for (final p in _patterns) {
      final m = p.firstMatch(s);
      if (m != null) return m.group(1);
    }
    return null;
  }

  if (_bareId.hasMatch(s)) return s;
  return null;
}
