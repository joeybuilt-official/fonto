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

import "../theme/tokens.dart";

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

/// Zero-content first-run state: a branded badge, a headline, one line of
/// explanation, and a real next action. Mirrors the web `LibraryEmptyState`
/// zero-content branch and the Home `stats.total === 0` onboarding card
/// (app/(app)/app/library/page.tsx, app/(app)/app/home/page.tsx) so a new
/// user is never handed a dead-end message on either platform.
///
/// Use this instead of [ListEmptyState] when the surface is empty because the
/// user has nothing yet — not because a filter narrowed the set to zero.
class FirstRunEmptyState extends StatelessWidget {
  const FirstRunEmptyState({
    super.key,
    required this.title,
    required this.primaryLabel,
    required this.onPrimary,
    this.body = "Add your photos to get started.",
    this.icon = Icons.photo_library_outlined,
    this.primaryIcon = Icons.upload,
    this.secondaryLabel,
    this.onSecondary,
  });

  /// Headline — the kind-aware "No … yet" line on Library surfaces, or
  /// "Add your photos" on the Home onboarding card.
  final String title;

  /// Supporting line under the headline.
  final String body;

  final IconData icon;

  final String primaryLabel;
  final IconData primaryIcon;
  final VoidCallback onPrimary;

  /// Optional second action (web pairs "Upload photos" with
  /// "Import from Google or Amazon"). Both must be set to render.
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final secondary = secondaryLabel;
    final onSecondaryTap = onSecondary;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(FontoSpace.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(FontoShape.large),
              ),
              child: Icon(
                icon,
                size: 28,
                color: theme.colorScheme.onPrimaryContainer,
              ),
            ),
            const SizedBox(height: FontoSpace.s4),
            Text(
              title,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: FontoSpace.s1),
            Text(
              body,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: FontoSpace.s4),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: FontoSpace.s2,
              runSpacing: FontoSpace.s2,
              children: [
                FilledButton.icon(
                  onPressed: onPrimary,
                  icon: Icon(primaryIcon),
                  label: Text(primaryLabel),
                ),
                if (secondary != null && onSecondaryTap != null)
                  OutlinedButton(
                    onPressed: onSecondaryTap,
                    child: Text(secondary),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Pulse envelope for the loading skeletons. Mirrors the web `animate-pulse`
/// utility that `GridSkeleton`/`ListSkeleton` use
/// (app/(app)/app/_components/grid-skeleton.tsx): opacity cycles 1 → 0.5 → 1.
///
/// One controller drives the whole group, so a 24-tile grid costs a single
/// ticker and every placeholder pulses in phase — same as the web grid, where
/// all tiles share one CSS animation timeline.
class _Pulse extends StatefulWidget {
  const _Pulse({required this.builder});

  /// Receives the shared opacity animation. Box call sites wrap their child in
  /// a `FadeTransition`; sliver call sites use `SliverFadeTransition`.
  final Widget Function(BuildContext context, Animation<double> opacity)
      builder;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: FontoMotion.extraLong,
  )..repeat(reverse: true);

  late final Animation<double> _opacity = Tween<double>(
    begin: 1,
    end: 0.5,
  ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _opacity);
}

/// Wraps a bespoke placeholder layout in the shared skeleton pulse, for
/// loading shapes that are neither a grid nor a list (e.g. the Home stats
/// row). One controller drives everything inside, so the whole placeholder
/// breathes in time with [GridSkeleton] and [ListSkeleton].
class SkeletonPulse extends StatelessWidget {
  const SkeletonPulse({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => _Pulse(
        builder: (_, opacity) => FadeTransition(
          opacity: opacity,
          child: child,
        ),
      );
}

/// Placeholder tile grid shown while an asset grid loads, instead of a lone
/// spinner in blank space — the user sees the shape of what's about to
/// arrive. Mirrors the web `<GridSkeleton>`.
///
/// Tiles are square and un-rounded because the real asset tile is: the
/// point is to pre-draw the incoming layout, not to invent a new one. The
/// fill matches [imageSkeleton] so a half-loaded grid stays visually uniform.
///
/// This one scrolls itself — use it where the skeleton IS the body. Inside a
/// `CustomScrollView`, use [SliverGridSkeleton].
class GridSkeleton extends StatelessWidget {
  const GridSkeleton({
    super.key,
    this.count = 18,
    this.crossAxisCount = 3,
    this.spacing = 4,
    this.padding = const EdgeInsets.all(4),
  });

  final int count;
  final int crossAxisCount;
  final double spacing;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.surfaceContainerHighest;
    return _Pulse(
      builder: (context, opacity) => FadeTransition(
        opacity: opacity,
        child: GridView.builder(
          padding: padding,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: crossAxisCount,
            crossAxisSpacing: spacing,
            mainAxisSpacing: spacing,
          ),
          itemCount: count,
          itemBuilder: (_, __) => ColoredBox(color: fill),
        ),
      ),
    );
  }
}

/// [GridSkeleton] as a sliver, for the `CustomScrollView` grids (Library
/// timeline, Search results) that need the skeleton to sit under a header or
/// the on-device strip rather than replace the whole viewport.
class SliverGridSkeleton extends StatelessWidget {
  const SliverGridSkeleton({
    super.key,
    this.count = 18,
    this.crossAxisCount = 3,
    this.spacing = 4,
    this.padding = const EdgeInsets.all(4),
  });

  final int count;
  final int crossAxisCount;
  final double spacing;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.surfaceContainerHighest;
    return _Pulse(
      builder: (context, opacity) => SliverFadeTransition(
        opacity: opacity,
        sliver: SliverPadding(
          padding: padding,
          sliver: SliverGrid(
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              crossAxisSpacing: spacing,
              mainAxisSpacing: spacing,
            ),
            delegate: SliverChildBuilderDelegate(
              (_, __) => ColoredBox(color: fill),
              childCount: count,
            ),
          ),
        ),
      ),
    );
  }
}

/// Placeholder rows (leading block + two text lines) for a loading list
/// surface. Mirrors the web `<ListSkeleton>` — same outlined-card row shape,
/// same 1/2 + 1/3 text-line widths.
///
/// Scrolls itself; use where the skeleton IS the body.
class ListSkeleton extends StatelessWidget {
  const ListSkeleton({
    super.key,
    this.count = 8,
    this.padding = const EdgeInsets.symmetric(
      horizontal: FontoSpace.s3,
      vertical: FontoSpace.s2,
    ),
  });

  final int count;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return _Pulse(
      builder: (context, opacity) => FadeTransition(
        opacity: opacity,
        child: ListView.separated(
          padding: padding,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: count,
          separatorBuilder: (_, __) => const SizedBox(height: 6),
          itemBuilder: (_, __) => Container(
            decoration: BoxDecoration(
              color: scheme.surface,
              border: Border.all(color: scheme.outlineVariant),
              borderRadius: BorderRadius.circular(FontoShape.medium),
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: FontoSpace.s4,
              vertical: FontoSpace.s3,
            ),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(FontoShape.small),
                  ),
                ),
                const SizedBox(width: FontoSpace.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _skeletonBar(scheme.surfaceContainerHighest, 0.5, 14),
                      const SizedBox(height: FontoSpace.s2),
                      _skeletonBar(scheme.surfaceContainerHighest, 1 / 3, 12),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Widget _skeletonBar(Color fill, double widthFactor, double height) =>
    FractionallySizedBox(
      alignment: Alignment.centerLeft,
      widthFactor: widthFactor,
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(FontoShape.full),
        ),
      ),
    );

/// Image placeholder that respects the MD3 surface scale — use as the
/// `placeholder`/`errorWidget` for `CachedNetworkImage` and the fallback
/// box for tiles whose URL isn't loaded yet. Dark mode renders a sensible
/// neutral instead of a hard `Colors.black12` tint.
Widget imageSkeleton(BuildContext context) => ColoredBox(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
    );

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
