// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Fonto Material 3 design tokens — web/TS half. Mirror of
// `mobile/lib/src/theme/tokens.dart` (Flutter) and the `--ft-*` CSS-var
// namespace in `app/globals.css`. ADR 0009 explains every decision.
//
// USAGE
// -----
// Prefer the CSS vars (`var(--ft-color-primary)`) inside Tailwind/style
// blocks — they hot-flip between `.dark` and light without remounting.
// This TS module is for places that need values at JS time: e.g., reading
// the brand seed for a `<meta name="theme-color">`, sizing a canvas based
// on a spacing token, or wiring a chart library that wants hex strings.

export const FONTO_BRAND_SEED = "#2AB0A5" as const;

/** MD3 color roles — value structure is identical for light + dark, only
 *  the hex strings differ. Read from `colorTokens.light` or `.dark`. */
export const colorTokens = {
  light: {
    primary: "#2AB0A5",
    onPrimary: "#FFFFFF",
    primaryContainer: "#A6E9DC",
    onPrimaryContainer: "#002020",
    secondary: "#4A6360",
    onSecondary: "#FFFFFF",
    secondaryContainer: "#CCE8E4",
    onSecondaryContainer: "#06201E",
    tertiary: "#436278",
    onTertiary: "#FFFFFF",
    tertiaryContainer: "#C9E6FF",
    onTertiaryContainer: "#001E30",
    error: "#BA1A1A",
    onError: "#FFFFFF",
    errorContainer: "#FFDAD6",
    onErrorContainer: "#410002",
    surface: "#FAFDFB",
    onSurface: "#191C1B",
    surfaceContainerLowest: "#FFFFFF",
    surfaceContainerLow: "#F4F7F5",
    surfaceContainer: "#EEF2EF",
    surfaceContainerHigh: "#E8ECEA",
    surfaceContainerHighest: "#E2E6E4",
    onSurfaceVariant: "#3F4947",
    outline: "#6F7977",
    outlineVariant: "#BFC9C7",
    inverseSurface: "#2D3231",
    onInverseSurface: "#EFF1EF",
    inversePrimary: "#6FCFC2",
    scrim: "#000000",
    shadow: "#000000",
  },
  dark: {
    primary: "#6FCFC2",
    onPrimary: "#003731",
    primaryContainer: "#005049",
    onPrimaryContainer: "#A6E9DC",
    secondary: "#B1CCC8",
    onSecondary: "#1C3532",
    secondaryContainer: "#324B48",
    onSecondaryContainer: "#CCE8E4",
    tertiary: "#A8CAE3",
    onTertiary: "#103248",
    tertiaryContainer: "#2A495F",
    onTertiaryContainer: "#C9E6FF",
    error: "#FFB4AB",
    onError: "#690005",
    errorContainer: "#93000A",
    onErrorContainer: "#FFDAD6",
    surface: "#101413",
    onSurface: "#E0E3E1",
    surfaceContainerLowest: "#0B0F0E",
    surfaceContainerLow: "#191D1C",
    surfaceContainer: "#1D2120",
    surfaceContainerHigh: "#272B2A",
    surfaceContainerHighest: "#323635",
    onSurfaceVariant: "#BFC9C7",
    outline: "#899391",
    outlineVariant: "#3F4947",
    inverseSurface: "#E0E3E1",
    onInverseSurface: "#2D3231",
    inversePrimary: "#006B61",
    scrim: "#000000",
    shadow: "#000000",
  },
} as const;

/** Shape (radii) — MD3 scale, 4 → 28 px + `full` pill. */
export const shapeTokens = {
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 28,
  full: 9999,
} as const;

/** Spacing — 4 px base. Mirrors `FontoSpace` on the Flutter side. */
export const spaceTokens = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
  s16: 64,
} as const;

/** Elevation strings ready for `boxShadow:`. MD3 level 0..5. */
export const elevationTokens = {
  level0: "none",
  level1: "0 1px 2px 0 rgba(0,0,0,0.06), 0 1px 3px 1px rgba(0,0,0,0.04)",
  level2: "0 1px 2px 0 rgba(0,0,0,0.08), 0 2px 6px 2px rgba(0,0,0,0.06)",
  level3: "0 4px 8px 3px rgba(0,0,0,0.08), 0 1px 3px 0 rgba(0,0,0,0.10)",
  level4: "0 6px 10px 4px rgba(0,0,0,0.10), 0 2px 3px 0 rgba(0,0,0,0.12)",
  level5: "0 8px 12px 6px rgba(0,0,0,0.12), 0 4px 4px 0 rgba(0,0,0,0.14)",
} as const;

/** Interaction state-layer opacities. Apply via color-mix or overlay. */
export const stateTokens = {
  hover: 0.08,
  focus: 0.1,
  pressed: 0.1,
  dragged: 0.16,
  disabledContainer: 0.12,
  disabledContent: 0.38,
} as const;

/** Motion durations + easings per MD3 motion spec. */
export const motionTokens = {
  duration: {
    short: 100,
    medium: 250,
    long: 400,
    extraLong: 700,
  },
  easing: {
    emphasized: "cubic-bezier(0.2, 0.0, 0, 1.0)",
    standard: "cubic-bezier(0.2, 0.0, 0, 1.0)",
    decel: "cubic-bezier(0.0, 0.0, 0, 1.0)",
    accel: "cubic-bezier(0.3, 0.0, 1, 1)",
  },
} as const;

/** Type scale per MD3. Sizes in px. Weights are CSS-numeric. */
export const typeTokens = {
  displayLarge: { size: 57, line: 64, tracking: -0.25, weight: 400 },
  displayMedium: { size: 45, line: 52, tracking: 0, weight: 400 },
  displaySmall: { size: 36, line: 44, tracking: 0, weight: 400 },
  headlineLarge: { size: 32, line: 40, tracking: 0, weight: 400 },
  headlineMedium: { size: 28, line: 36, tracking: 0, weight: 400 },
  headlineSmall: { size: 24, line: 32, tracking: 0, weight: 400 },
  titleLarge: { size: 22, line: 28, tracking: 0, weight: 500 },
  titleMedium: { size: 16, line: 24, tracking: 0.15, weight: 500 },
  titleSmall: { size: 14, line: 20, tracking: 0.1, weight: 500 },
  bodyLarge: { size: 16, line: 24, tracking: 0.5, weight: 400 },
  bodyMedium: { size: 14, line: 20, tracking: 0.25, weight: 400 },
  bodySmall: { size: 12, line: 16, tracking: 0.4, weight: 400 },
  labelLarge: { size: 14, line: 20, tracking: 0.1, weight: 500 },
  labelMedium: { size: 12, line: 16, tracking: 0.5, weight: 500 },
  labelSmall: { size: 11, line: 16, tracking: 0.5, weight: 500 },
} as const;

export type ColorRoleName = keyof typeof colorTokens.light;
export type TypeRoleName = keyof typeof typeTokens;
