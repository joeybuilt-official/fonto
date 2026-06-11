// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto Material 3 design tokens — mobile half. The token names here match
// the web side at `/workspace/fonto/lib/design-tokens.ts` so any contributor
// can move between platforms without re-learning vocab.
//
// Seed: `#2AB0A5` — the same brand teal used in app/icon.png + globals.css
// `--primary`. We feed the seed through Flutter's `ColorScheme.fromSeed`
// (Material 3 tonal palette generator) so every role-coloured token
// (primary/secondary/tertiary/surface/etc., × 4 contrast levels × light+dark)
// is derived consistently from one input.
//
// See ADR 0009 (`/workspace/fonto/adr/0009-material-design-3.md`) for the
// why behind every value in this file.

import "package:flutter/material.dart";

/// Brand seed colour. Single source of truth for the tonal palette.
const Color brandSeed = Color(0xFF2AB0A5);

/// Fonto extension to MD3's color roles. Material 3 doesn't ship a "success"
/// role; we add one because import-complete / uploaded / saved states show
/// up frequently and `tertiary`/`secondary` were getting overloaded as a
/// stand-in. Light values are tone-40 / 90; dark values are tone-80 / 30
/// — same generation rules MD3 uses for the spec roles.
///
/// Read at call site via `Theme.of(context).extension<FontoColors>()!.success`.
class FontoColors extends ThemeExtension<FontoColors> {
  const FontoColors({
    required this.success,
    required this.onSuccess,
    required this.successContainer,
    required this.onSuccessContainer,
  });

  final Color success;
  final Color onSuccess;
  final Color successContainer;
  final Color onSuccessContainer;

  static const FontoColors light = FontoColors(
    success: Color(0xFF006E1C),
    onSuccess: Color(0xFFFFFFFF),
    successContainer: Color(0xFFABF59B),
    onSuccessContainer: Color(0xFF002106),
  );

  static const FontoColors dark = FontoColors(
    success: Color(0xFF88D982),
    onSuccess: Color(0xFF003910),
    successContainer: Color(0xFF005313),
    onSuccessContainer: Color(0xFFA4F49C),
  );

  @override
  FontoColors copyWith({
    Color? success,
    Color? onSuccess,
    Color? successContainer,
    Color? onSuccessContainer,
  }) {
    return FontoColors(
      success: success ?? this.success,
      onSuccess: onSuccess ?? this.onSuccess,
      successContainer: successContainer ?? this.successContainer,
      onSuccessContainer: onSuccessContainer ?? this.onSuccessContainer,
    );
  }

  @override
  FontoColors lerp(ThemeExtension<FontoColors>? other, double t) {
    if (other is! FontoColors) return this;
    return FontoColors(
      success: Color.lerp(success, other.success, t)!,
      onSuccess: Color.lerp(onSuccess, other.onSuccess, t)!,
      successContainer: Color.lerp(successContainer, other.successContainer, t)!,
      onSuccessContainer: Color.lerp(onSuccessContainer, other.onSuccessContainer, t)!,
    );
  }
}

/// Shape scale per Material 3 (`small`, `medium`, `large`, `extra-large`).
/// We use the upstream defaults — they read as "Material" without feeling
/// rounder than the brand wants. Buttons + chips inherit pill shapes; cards
/// inherit `medium` (12 px); sheets inherit `extra-large` (28 px top).
abstract final class FontoShape {
  static const double small = 8;
  static const double medium = 12;
  static const double large = 16;
  static const double extraLarge = 28;
  // Pill shape for FAB / extended FAB / segmented buttons. Material 3 maps
  // these to `StadiumBorder()`; we keep the constant here for places that
  // need an explicit radius value.
  static const double full = 9999;
}

/// Spacing scale (Material 3 uses a 4 px base). Tokens map 1:1 to the web
/// side. Don't reach for inline `EdgeInsets.all(7)` — pick the nearest token.
abstract final class FontoSpace {
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s8 = 32;
  static const double s10 = 40;
  static const double s12 = 48;
  static const double s16 = 64;
}

/// Motion timing per Material 3 motion spec — the four most common durations.
/// Curve choice (`emphasized`, `standard`, `decel`, etc.) lives at call site
/// because Flutter's `Curves` set already mirrors the spec.
abstract final class FontoMotion {
  /// Short transitions — icon state, selection ripple. ~50-100 ms in MD3.
  static const Duration short = Duration(milliseconds: 100);

  /// Mid transitions — bottom sheet slide, dialog show. ~200-300 ms.
  static const Duration medium = Duration(milliseconds: 250);

  /// Long transitions — full-screen navigation. ~400-500 ms.
  static const Duration long = Duration(milliseconds: 400);

  /// Extra-long — onboarding, hero. Use sparingly.
  static const Duration extraLong = Duration(milliseconds: 700);
}

/// Type scale per Material 3 (display / headline / title / body / label,
/// each with large/medium/small). Wired into `TextTheme` in `app_theme.dart`.
/// Values reflect the MD3 spec; weights default to 400/500 with 700 reserved
/// for true emphasis. Letter spacing is intentionally negative on display +
/// headline to compress the optical balance at large sizes.
///
/// Inter on Android. The platform falls back to Roboto if Inter isn't on
/// the device — both render the spec acceptably.
abstract final class FontoType {
  static const String family = "Inter";

  // Display — hero copy / splashy headers. Rare on a mobile photo app.
  static const TextStyle displayLarge =
      TextStyle(fontSize: 57, height: 1.12, letterSpacing: -0.25, fontWeight: FontWeight.w400);
  static const TextStyle displayMedium =
      TextStyle(fontSize: 45, height: 1.15, letterSpacing: 0, fontWeight: FontWeight.w400);
  static const TextStyle displaySmall =
      TextStyle(fontSize: 36, height: 1.22, letterSpacing: 0, fontWeight: FontWeight.w400);

  // Headline — screen titles ("Library", "People", "Memories").
  static const TextStyle headlineLarge =
      TextStyle(fontSize: 32, height: 1.25, letterSpacing: 0, fontWeight: FontWeight.w400);
  static const TextStyle headlineMedium =
      TextStyle(fontSize: 28, height: 1.28, letterSpacing: 0, fontWeight: FontWeight.w400);
  static const TextStyle headlineSmall =
      TextStyle(fontSize: 24, height: 1.33, letterSpacing: 0, fontWeight: FontWeight.w400);

  // Title — section headers, card titles, prominent list items.
  static const TextStyle titleLarge =
      TextStyle(fontSize: 22, height: 1.27, letterSpacing: 0, fontWeight: FontWeight.w500);
  static const TextStyle titleMedium =
      TextStyle(fontSize: 16, height: 1.5, letterSpacing: 0.15, fontWeight: FontWeight.w500);
  static const TextStyle titleSmall =
      TextStyle(fontSize: 14, height: 1.43, letterSpacing: 0.1, fontWeight: FontWeight.w500);

  // Body — paragraph copy, secondary metadata.
  static const TextStyle bodyLarge =
      TextStyle(fontSize: 16, height: 1.5, letterSpacing: 0.5, fontWeight: FontWeight.w400);
  static const TextStyle bodyMedium =
      TextStyle(fontSize: 14, height: 1.43, letterSpacing: 0.25, fontWeight: FontWeight.w400);
  static const TextStyle bodySmall =
      TextStyle(fontSize: 12, height: 1.33, letterSpacing: 0.4, fontWeight: FontWeight.w400);

  // Label — buttons, chips, tabs, captions.
  static const TextStyle labelLarge =
      TextStyle(fontSize: 14, height: 1.43, letterSpacing: 0.1, fontWeight: FontWeight.w500);
  static const TextStyle labelMedium =
      TextStyle(fontSize: 12, height: 1.33, letterSpacing: 0.5, fontWeight: FontWeight.w500);
  static const TextStyle labelSmall =
      TextStyle(fontSize: 11, height: 1.45, letterSpacing: 0.5, fontWeight: FontWeight.w500);

  /// Builds a complete `TextTheme` with the family applied so the call site
  /// can drop it into `ThemeData(textTheme: FontoType.textTheme)`.
  static TextTheme get textTheme => const TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      ).apply(fontFamily: family);
}
