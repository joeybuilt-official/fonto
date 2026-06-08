// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7 — shared 4-state pattern for list surfaces (Library, Collections
// tabs, Search, Updates, Explore). Matches the web `ListErrorState` +
// `LibraryEmptyState` contract so users see consistent copy + CTAs across
// surfaces.
//
// The web equivalents live at:
//   /workspace/fonto/app/(app)/app/_components/list-states.tsx
//   /workspace/fonto/app/(app)/app/library/page.tsx (LibraryEmptyState)

import "package:flutter/material.dart";

/// Error state with a Retry button. Used by every list surface that can
/// fail mid-fetch (Library, Collections, Search, Updates, Explore).
class ListErrorState extends StatelessWidget {
  const ListErrorState({
    super.key,
    required this.onRetry,
    this.message = "Couldn't load this. Check your connection and retry.",
  });

  final VoidCallback onRetry;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.error_outline,
              size: 40,
              color: theme.colorScheme.error.withValues(alpha: 0.7),
            ),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            OutlinedButton(
              onPressed: onRetry,
              child: const Text("Retry"),
            ),
          ],
        ),
      ),
    );
  }
}

/// Generic empty state with a kind-aware default message + optional
/// filter-aware variant w/ Clear filters CTA. Mirrors the web
/// LibraryEmptyState contract.
class ListEmptyState extends StatelessWidget {
  const ListEmptyState({
    super.key,
    required this.message,
    this.icon = Icons.photo_library_outlined,
    this.hint,
    this.filtered = false,
    this.onClearFilters,
  });

  /// Kind-aware default copy, e.g. "No moments yet. Photos you take show up here."
  /// or "No documents." When `filtered` is true, prefer "No <kind> match these filters."
  final String message;
  final IconData icon;

  /// Secondary line shown under the headline message. Useful for default-empty
  /// states that want a "try uploading…" call-to-action description.
  final String? hint;

  /// Set true when at least one filter is active. Renders the "Clear filters"
  /// CTA so the user can recover without backing out of the surface.
  final bool filtered;
  final VoidCallback? onClearFilters;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: muted),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: muted),
            ),
            if (hint != null) ...[
              const SizedBox(height: 6),
              Text(
                hint!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(color: muted),
              ),
            ],
            if (filtered && onClearFilters != null) ...[
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: onClearFilters,
                child: const Text("Clear filters"),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Kind-aware default empty copy for the Library and filtered-asset surfaces.
/// Used when no filter is set — pairs with the web LENS_EMPTY map.
String defaultEmptyForKind(String? kind) {
  switch (kind) {
    case "moment":
      return "No moments yet. Photos you take show up here.";
    case "screenshot":
      return "No screenshots.";
    case "graphics":
      return "No graphics yet. Logos, mockups, icons, and art show up here.";
    case "document":
      return "No documents.";
    case "video":
      return "No videos.";
    case "all":
      return "No assets in your library yet.";
    case null:
      return "No assets yet. Tap + to add.";
    default:
      return "No assets in your library yet.";
  }
}

/// Filter-aware empty copy used when a filter narrows the result set to zero.
String filteredEmptyForKind(String? kind) {
  switch (kind) {
    case "moment":
      return "No moments match these filters.";
    case "screenshot":
      return "No screenshots match these filters.";
    case "graphics":
      return "No graphics match these filters.";
    case "document":
      return "No documents match these filters.";
    case "video":
      return "No videos match these filters.";
    default:
      return "No assets match these filters.";
  }
}
