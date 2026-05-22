// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PhotoCard, type Asset } from "./photo-card";

// Tile sizing — must agree with the grid below.
// Estimated tile edge in px (square aspect). Used to pre-compute virtual row
// heights before the real DOM measures itself.
const TILE_ESTIMATE_PX = 140;
const TILE_GAP_PX = 4; // matches `gap-1` (0.25rem)
const HEADER_HEIGHT_PX = 44;
const SECTION_PADDING_PX = 24; // gap below the grid before next month

// Column counts at each Tailwind breakpoint. Mirrors the timeline grid below
// (`grid-cols-3 sm:4 md:5 lg:6 xl:8`). Detected client-side.
const BREAKPOINTS = [
  { min: 1280, cols: 8 }, // xl
  { min: 1024, cols: 6 }, // lg
  { min: 768, cols: 5 }, // md
  { min: 640, cols: 4 }, // sm
  { min: 0, cols: 3 },
] as const;

function detectCols(width: number): number {
  for (const bp of BREAKPOINTS) {
    if (width >= bp.min) return bp.cols;
  }
  return 3;
}

export interface MonthBucket {
  key: string; // YYYY-MM
  label: string; // e.g. "January 2026"
  shortLabel: string; // e.g. "Jan 2026"
  assets: Asset[];
}

export function groupAssetsByMonth(assets: Asset[]): MonthBucket[] {
  const map = new Map<string, Asset[]>();
  for (const a of assets) {
    const ts = a.capturedAt ?? a.createdAt;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(a);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, monthAssets]) => {
      const [yStr, mStr] = key.split("-");
      const d = new Date(parseInt(yStr, 10), parseInt(mStr, 10) - 1, 1);
      return {
        key,
        label: d.toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        }),
        shortLabel: d.toLocaleDateString(undefined, {
          month: "short",
          year: "numeric",
        }),
        assets: monthAssets,
      };
    });
}

export interface VirtualizedTimelineProps {
  assets: Asset[];
  onAssetClick: (asset: Asset) => void;
  /** Called when the viewport approaches the end of the current dataset.
   * Implementers can fetch more pages. Idempotent — the timeline only signals
   * once per buckets identity, so guard against duplicate fetches in the
   * caller. */
  onNearEnd?: () => void;
  /** Pixels from the bottom of the last virtualized row that should trigger
   * `onNearEnd`. Defaults to one viewport height. */
  nearEndThresholdPx?: number;
}

/**
 * Virtualized, month-bucketed asset timeline.
 *
 * Each virtual item is a month. The month's height is computed from the
 * number of asset rows at the current grid column count plus the sticky
 * header. The scroll container is the parent `<main>` element from
 * `AppShell` — looked up via `closest("main")` so we don't need to thread a
 * ref down through the layout.
 */
export function VirtualizedTimeline({
  assets,
  onAssetClick,
  onNearEnd,
  nearEndThresholdPx,
}: VirtualizedTimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const [cols, setCols] = useState<number>(() =>
    typeof window === "undefined" ? 6 : detectCols(window.innerWidth)
  );

  const buckets = useMemo(() => groupAssetsByMonth(assets), [assets]);

  // Resolve the page-level scroll container once mounted. AppShell wraps
  // page content in `<main class="overflow-y-auto …">` — that's our scroll
  // element. Falls back to document.scrollingElement if not found.
  useLayoutEffect(() => {
    if (!parentRef.current) return;
    const main = parentRef.current.closest("main");
    scrollElRef.current = (main ?? document.scrollingElement) as HTMLElement | null;
  }, []);

  // Track column count from window width.
  useEffect(() => {
    function update() {
      setCols(detectCols(window.innerWidth));
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const estimateMonthSize = useCallback(
    (index: number) => {
      const bucket = buckets[index];
      if (!bucket) return HEADER_HEIGHT_PX;
      const rows = Math.max(1, Math.ceil(bucket.assets.length / cols));
      return (
        HEADER_HEIGHT_PX +
        rows * TILE_ESTIMATE_PX +
        (rows - 1) * TILE_GAP_PX +
        SECTION_PADDING_PX
      );
    },
    [buckets, cols]
  );

  const virtualizer = useVirtualizer({
    count: buckets.length,
    getScrollElement: () => scrollElRef.current,
    estimateSize: estimateMonthSize,
    overscan: 2,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Re-measure when column count changes — tile heights shift on resize.
  useEffect(() => {
    virtualizer.measure();
  }, [cols, virtualizer]);

  // Track current month for sticky indicator.
  const virtualItems = virtualizer.getVirtualItems();
  const currentBucketKey = virtualItems[0]?.index != null
    ? buckets[virtualItems[0].index]?.key ?? null
    : null;

  // Near-end pagination signal.
  const lastSignaledLengthRef = useRef(0);
  useEffect(() => {
    if (!onNearEnd || buckets.length === 0) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    const scrollEl = scrollElRef.current;
    if (!scrollEl) return;

    const threshold = nearEndThresholdPx ?? scrollEl.clientHeight;
    const totalSize = virtualizer.getTotalSize();
    const scrolledFromBottom =
      totalSize - (scrollEl.scrollTop + scrollEl.clientHeight);

    if (
      last.index >= buckets.length - 1 &&
      scrolledFromBottom < threshold &&
      lastSignaledLengthRef.current !== assets.length
    ) {
      lastSignaledLengthRef.current = assets.length;
      onNearEnd();
    }
  }, [virtualItems, assets.length, buckets.length, onNearEnd, nearEndThresholdPx, virtualizer]);

  // Keyboard navigation on the timeline container.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const scrollEl = scrollElRef.current;
      if (!scrollEl) return;
      switch (e.key) {
        case "PageDown": {
          e.preventDefault();
          scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.9, behavior: "smooth" });
          break;
        }
        case "PageUp": {
          e.preventDefault();
          scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.9, behavior: "smooth" });
          break;
        }
        case "Home": {
          e.preventDefault();
          if (buckets.length > 0) {
            virtualizer.scrollToIndex(0, { align: "start" });
          }
          break;
        }
        case "End": {
          e.preventDefault();
          if (buckets.length > 0) {
            virtualizer.scrollToIndex(buckets.length - 1, { align: "start" });
          }
          break;
        }
        default:
          break;
      }
    },
    [buckets.length, virtualizer]
  );

  const totalSize = virtualizer.getTotalSize();

  const jumpToMonth = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: "start" });
    },
    [virtualizer]
  );

  return (
    <div className="relative" role="grid" aria-label="Asset timeline" aria-rowcount={buckets.length}>
      {/* Sticky current-month chip — appears on the left of the scroll viewport */}
      {currentBucketKey && (
        <div className="pointer-events-none sticky top-2 z-20 mb-1 flex">
          <div className="pointer-events-auto rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur-sm">
            {buckets.find((b) => b.key === currentBucketKey)?.label ?? ""}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        {/* Virtualized list */}
        <div
          ref={parentRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="flex-1 outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
        >
          <div
            style={{
              height: `${totalSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const bucket = buckets[virtualRow.index];
              if (!bucket) return null;
              const imageAssets = bucket.assets.filter((a) =>
                a.mimeType.startsWith("image/")
              );
              const otherAssets = bucket.assets.filter(
                (a) => !a.mimeType.startsWith("image/")
              );
              return (
                <div
                  key={bucket.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  role="row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    className="mb-2 flex items-baseline gap-3 px-1 py-2"
                    style={{ minHeight: HEADER_HEIGHT_PX }}
                  >
                    <h2 className="text-sm font-semibold uppercase tracking-widest text-foreground">
                      {bucket.label}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      · {bucket.assets.length}{" "}
                      {bucket.assets.length === 1 ? "asset" : "assets"}
                    </span>
                  </div>

                  {imageAssets.length > 0 && (
                    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                      {imageAssets.map((asset) => (
                        <PhotoCard
                          key={asset.id}
                          asset={asset}
                          showQuickActions
                          onClick={() => onAssetClick(asset)}
                        />
                      ))}
                    </div>
                  )}

                  {otherAssets.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {otherAssets.map((asset) => (
                        <div
                          key={asset.id}
                          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 transition-colors hover:bg-muted/40"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {asset.filename}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {asset.classification ?? asset.mimeType}
                            </p>
                          </div>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {new Date(
                              asset.capturedAt ?? asset.createdAt
                            ).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ height: SECTION_PADDING_PX }} aria-hidden="true" />
                </div>
              );
            })}
          </div>
        </div>

        {/* Right-rail date scrubber */}
        <DateScrubber
          buckets={buckets}
          currentKey={currentBucketKey}
          onJump={jumpToMonth}
        />
      </div>
    </div>
  );
}

interface DateScrubberProps {
  buckets: MonthBucket[];
  currentKey: string | null;
  onJump: (index: number) => void;
}

function DateScrubber({ buckets, currentKey, onJump }: DateScrubberProps) {
  if (buckets.length <= 1) return null;
  return (
    <nav
      aria-label="Jump to month"
      className="sticky top-0 hidden h-[calc(100dvh-8rem)] w-20 shrink-0 self-start overflow-y-auto py-2 md:flex md:flex-col"
    >
      <ul className="flex flex-col gap-0.5">
        {buckets.map((bucket, index) => {
          const isCurrent = bucket.key === currentKey;
          return (
            <li key={bucket.key}>
              <button
                type="button"
                onClick={() => onJump(index)}
                className={`w-full rounded px-2 py-1 text-left text-[11px] font-medium tabular-nums transition-colors ${
                  isCurrent
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                aria-current={isCurrent ? "true" : undefined}
              >
                {bucket.shortLabel}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
