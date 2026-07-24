// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared loading skeletons for list surfaces (Library grid, Search /
// Documents lists). Renders grey placeholder tiles at the real column
// count/density instead of a lone centered spinner in blank space — the
// user sees the shape of what's about to arrive. Loader2 stays reserved
// for button-scoped waits and infinite-scroll "load more" sentinels.
//
// Column counts mirror AssetGrid.columnsFor() so the skeleton lands at
// the same density the grid will use once assets resolve.

"use client";

// Comfortable (default) breakpoints track AssetGrid.columnsFor: 2 → 3 → 4 → 6.
// Compact and dense step up proportionally.
const GRID_COLS: Record<string, string> = {
  comfortable: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6",
  compact: "grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8",
  dense: "grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10",
};

/**
 * Grid of grey rounded tiles for a loading photo/asset grid. Column count
 * matches the density the real AssetGrid will render at.
 */
export function GridSkeleton({
  count = 18,
  density = "comfortable",
}: {
  count?: number;
  density?: "comfortable" | "compact" | "dense";
}) {
  return (
    <div
      className={`grid gap-2 ${GRID_COLS[density] ?? GRID_COLS.comfortable}`}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="aspect-square animate-pulse rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-high)]"
        />
      ))}
    </div>
  );
}

/**
 * Vertical list of grey placeholder rows (leading icon block + two text
 * lines) for a loading list surface — matches the DocRow / ResultRow shape.
 */
export function ListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] px-4 py-3"
        >
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container-high)]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-1/2 animate-pulse rounded-full bg-[var(--ft-color-surface-container-high)]" />
            <div className="h-3 w-1/3 animate-pulse rounded-full bg-[var(--ft-color-surface-container-high)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
