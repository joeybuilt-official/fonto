// SPDX-License-Identifier: MIT
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

// A Takeout direct-download URL identifies the export by a UUID, not a Drive
// file ID (e.g. ...?id=8e0f24e6-…-9bed6647c0d0&i=54&user=…&rapt=…). Real Drive
// file IDs are never UUIDs, so the 8-4-4-4-12 hex shape is a reliable tell.
final RegExp _uuid = RegExp(
  r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  caseSensitive: false,
);

/// What a pasted value actually is.
enum DriveInputKind { id, takeoutDownload, none }

class DriveInput {
  const DriveInput(this.kind, [this.fileId]);
  final DriveInputKind kind;
  final String? fileId;
}

/// Classify a pasted value: a usable Drive file ID, a temporary Takeout
/// download-link (signed googleusercontent URL the server can't re-fetch), or
/// nothing recognizable. Mirrors classifyDriveInput in lib/import/driveLink.ts.
DriveInput classifyDriveInput(String input) {
  final s = input.trim();
  if (s.isEmpty) return const DriveInput(DriveInputKind.none);

  final lower = s.toLowerCase();
  final looksLikeTakeoutDownload = lower.contains("rapt=") ||
      lower.contains("googleusercontent.com") ||
      lower.contains("usercontent.google");

  String? candidate;
  if (s.contains("/") || s.contains("?") || s.contains("=")) {
    for (final p in _patterns) {
      final m = p.firstMatch(s);
      if (m != null) {
        candidate = m.group(1);
        break;
      }
    }
  } else if (_bareId.hasMatch(s)) {
    candidate = s;
  }

  if (looksLikeTakeoutDownload ||
      (candidate != null && _uuid.hasMatch(candidate))) {
    return const DriveInput(DriveInputKind.takeoutDownload);
  }
  return candidate != null
      ? DriveInput(DriveInputKind.id, candidate)
      : const DriveInput(DriveInputKind.none);
}

/// Returns the Drive file ID parsed from [input], or null if none found.
String? parseDriveFileId(String input) {
  final c = classifyDriveInput(input);
  return c.kind == DriveInputKind.id ? c.fileId : null;
}
