// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto Material 3 ThemeData factory — light + dark variants from the
// shared brand seed. See `tokens.dart` for the underlying scale and ADR
// 0009 for the per-decision rationale.

import "package:flutter/material.dart";

import "tokens.dart";

class FontoTheme {
  /// Light theme. `surface` is the default screen background — MD3 deprecated
  /// `background` in favour of `surface` + a tonal scale, so we lean on
  /// `surface*` tokens throughout the app.
  static ThemeData light() => _build(Brightness.light);

  /// Dark theme. MD3 dark mode uses lower-chroma roles + higher elevation
  /// tint so photo content stays the visual centre of attention.
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(
      seedColor: brandSeed,
      brightness: brightness,
    );
    return ThemeData(
      colorScheme: scheme,
      useMaterial3: true,
      // Fonto's "success" role — MD3 doesn't ship one. Read via
      // `Theme.of(context).extension<FontoColors>()!.success`.
      extensions: <ThemeExtension<dynamic>>[
        brightness == Brightness.dark ? FontoColors.dark : FontoColors.light,
      ],
      textTheme: FontoType.textTheme,
      // Anchor the global background to the tonal surface scale so screens
      // stop bleeding through to default white on cold start.
      scaffoldBackgroundColor: scheme.surface,
      // AppBar should sit on `surface` with the default tint, not a hard
      // primary fill — keeps the chrome calm when scrolled to top of a
      // dense photo grid.
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 2,
        centerTitle: false,
        titleTextStyle: FontoType.titleLarge.copyWith(color: scheme.onSurface),
      ),
      // Cards default to `surfaceContainerLow` so they read as distinct from
      // the page background without claiming the high-emphasis container slot.
      cardTheme: CardThemeData(
        color: scheme.surfaceContainerLow,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FontoShape.medium),
        ),
        margin: EdgeInsets.zero,
      ),
      // Bottom sheets get the larger MD3 corner — feels right on photo
      // detail viewers + library filter sheets.
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
        elevation: 1,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(FontoShape.extraLarge),
            topRight: Radius.circular(FontoShape.extraLarge),
          ),
        ),
      ),
      // Bottom nav (the persistent rail on mobile) is the most-touched
      // surface; pin it to `surfaceContainer` so it stays legible against
      // photo-dense screens above it without grabbing a primary fill.
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surfaceContainer,
        indicatorColor: scheme.secondaryContainer,
        labelTextStyle: WidgetStatePropertyAll(FontoType.labelMedium),
        elevation: 0,
        height: 80,
      ),
      // Dialogs hit `surfaceContainerHigh` — one elevation step above the
      // backdrop scrim so the cut-out reads cleanly.
      dialogTheme: DialogThemeData(
        backgroundColor: scheme.surfaceContainerHigh,
        elevation: 3,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FontoShape.large),
        ),
      ),
      // Buttons / chips / inputs default to MD3 shapes; explicit overrides
      // only where the spec needed a Fonto-specific tweak. Filled buttons
      // are pill-shaped per MD3 — feels right for the share + upload
      // CTAs we already use.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          shape: const StadiumBorder(),
          padding: const EdgeInsets.symmetric(
            horizontal: FontoSpace.s6,
            vertical: FontoSpace.s3,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          shape: const StadiumBorder(),
          padding: const EdgeInsets.symmetric(
            horizontal: FontoSpace.s6,
            vertical: FontoSpace.s3,
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(FontoShape.full),
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: FontoSpace.s4,
            vertical: FontoSpace.s3,
          ),
        ),
      ),
      // Chips: filled style w/ stadium shape — used heavily in the lens
      // filter row + people / collection tags.
      chipTheme: ChipThemeData(
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(
          horizontal: FontoSpace.s3,
          vertical: FontoSpace.s1,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHigh,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(FontoShape.small),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(FontoShape.small),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(FontoShape.small),
          borderSide: BorderSide(color: scheme.primary, width: 2),
        ),
      ),
      // SnackBar: filled inverse — matches MD3 spec for transient feedback.
      snackBarTheme: SnackBarThemeData(
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: FontoType.bodyMedium.copyWith(color: scheme.onInverseSurface),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FontoShape.small),
        ),
        behavior: SnackBarBehavior.floating,
      ),
      // Dividers are intentionally faint — photo grids look cleaner without
      // strong horizontal rules cutting them up.
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: 1,
        space: 1,
      ),
    );
  }
}
