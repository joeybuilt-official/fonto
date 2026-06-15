// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Map Plexo VLM scene labels to a year-agnostic
// monthly mask. Pure + DB-free so it is unit-testable in isolation.
//
// A scene-season signal is "near-useless alone, strong × a year bound"
// (ADR-0003): "snow" doesn't say WHICH winter, but combined with an
// identity/EXIF year it sharpens the month. We therefore emit only the candidate
// MONTHS (1..12), never a year.
//
// Hemisphere is unknown to us (no reliable geo on most assets), so the mask is
// NORTHERN by default. The Phase 4 likelihood fn flips it when the asset has a
// southern-latitude EXIF GPS fix — that geo-flip lives with fusion, not here.

export type Season = "winter" | "spring" | "summer" | "autumn";

const SEASON_MONTHS: Record<Season, number[]> = {
  winter: [12, 1, 2],
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
};

// Label substring → season. Lowercased; matched as a whole-word-ish substring
// against the deduped VLM label list. Holidays that pin a single month are in
// HOLIDAY_MONTHS below and take precedence (a narrower signal).
const SEASON_KEYWORDS: Array<{ re: RegExp; season: Season }> = [
  { re: /\b(snow|snowman|snowy|ski|skiing|snowboard|sled|sledding|icicle|frost|blizzard|winter)\b/, season: "winter" },
  { re: /\b(blossom|cherry blossom|tulip|daffodil|spring)\b/, season: "spring" },
  { re: /\b(beach|swimming|swimsuit|pool|sunbathing|sandcastle|sunflower|summer)\b/, season: "summer" },
  { re: /\b(autumn|fall foliage|foliage|pumpkin|harvest)\b/, season: "autumn" },
];

// Label substring → a single month (1..12). Narrower than a season; when present
// the result collapses to just that month.
const HOLIDAY_MONTHS: Array<{ re: RegExp; month: number }> = [
  { re: /\b(christmas|santa|nativity|christmas tree)\b/, month: 12 },
  { re: /\b(halloween|jack-o-lantern|jack o lantern|trick or treat)\b/, month: 10 },
  { re: /\b(thanksgiving)\b/, month: 11 },
  { re: /\b(easter)\b/, month: 4 },
  { re: /\b(valentine)\b/, month: 2 },
];

export interface SeasonMask {
  seasons: Season[];
  /** Sorted, deduped candidate months (1..12). Empty = no seasonal signal. */
  months: number[];
  /** The labels that fired, for the evidence artifact / explanation. */
  matchedLabels: string[];
}

/**
 * Reduce a VLM label list to a monthly mask. Returns an empty mask (months: [])
 * when nothing seasonal matched — the caller then emits NO scene_season row
 * (absent evidence, not a flat one).
 */
export function seasonMaskFromLabels(labels: string[]): SeasonMask {
  const hay = labels.map((l) => l.toLowerCase());
  const joined = ` ${hay.join(" ")} `;

  const matchedLabels: string[] = [];
  const monthSet = new Set<number>();
  const seasonSet = new Set<Season>();

  let holidayHit = false;
  for (const { re, month } of HOLIDAY_MONTHS) {
    if (re.test(joined)) {
      holidayHit = true;
      monthSet.add(month);
      matchedLabels.push(...hay.filter((l) => re.test(` ${l} `)));
    }
  }

  for (const { re, season } of SEASON_KEYWORDS) {
    if (re.test(joined)) {
      seasonSet.add(season);
      matchedLabels.push(...hay.filter((l) => re.test(` ${l} `)));
      // A holiday already narrowed to a month — keep the season tag for the
      // artifact but don't widen the month set back out.
      if (!holidayHit) for (const m of SEASON_MONTHS[season]) monthSet.add(m);
    }
  }

  return {
    seasons: Array.from(seasonSet).sort(),
    months: Array.from(monthSet).sort((a, b) => a - b),
    matchedLabels: Array.from(new Set(matchedLabels)),
  };
}
