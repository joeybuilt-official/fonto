// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 / M2 — the tile shown for an asset that can NEVER be previewed
// (server sends previewUnavailable, derived from thumbnail_state = 'skipped').
//
// Why this exists rather than letting the image widget fail: the asset URL
// endpoint transparently falls back to the ORIGINAL when no derivative exists,
// and for these assets the original is precisely the file nothing can decode.
// Rendering it would cost a request per tile and end in Icons.broken_image —
// the outcome the expert panel explicitly ruled out. Never a broken-image
// glyph, never silent omission from the grid.
//
// Mirrors the web tile in app/(app)/app/_components/photo-card.tsx: format
// named, one plain sentence, dimensions when known. Meaning is carried by text,
// never by colour alone, and the whole tile carries a semantics label so a
// screen reader announces the substitute rather than an unlabelled box.

import "package:flutter/material.dart";
import "../api/models.dart";

class PreviewUnavailableTile extends StatelessWidget {
  const PreviewUnavailableTile({super.key, required this.asset, this.compact = true});

  final Asset asset;

  /// Grid tiles are small — drop the dimensions line and shrink the icon.
  /// The detail view passes false and shows the full explanation.
  final bool compact;

  /// Short, human-facing format name: "DNG", "PSD". Prefers the filename
  /// extension, which is what a person recognises, and falls back to the mime
  /// subtype with its vendor prefix stripped.
  static String formatLabel(Asset asset) {
    final dot = asset.filename.lastIndexOf(".");
    if (dot > 0 && dot < asset.filename.length - 1) {
      return asset.filename.substring(dot + 1).toUpperCase();
    }
    final parts = asset.mimeType.split("/");
    final sub = parts.length > 1 ? parts[1] : asset.mimeType;
    return sub.replaceFirst(RegExp(r"^x-"), "").toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = formatLabel(asset);
    final dims = (asset.widthPx != null && asset.heightPx != null)
        ? "${asset.widthPx}×${asset.heightPx}"
        : null;

    return Semantics(
      image: true,
      label: "$label — no preview available. ${asset.filename}",
      child: Container(
        color: theme.colorScheme.surfaceContainerHigh,
        padding: const EdgeInsets.all(6),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.image_not_supported_outlined,
              size: compact ? 28 : 40,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                fontWeight: FontWeight.bold,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              "No preview available",
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (!compact && dims != null) ...[
              const SizedBox(height: 2),
              Text(
                dims,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
