// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 — seekable, lazy-loading month timeline (Google/Apple-Photos style).
//
// The full-library month buckets (GET /api/v1/assets/buckets) drive BOTH the
// virtualized row set (one row per month, height reserved from the month's
// count) AND the right-rail fast-scrubber. Because every month has a
// height-reserved slot, the native scrollbar + the scrubber both span the
// entire library, not just what's loaded. Each month's actual assets are
// fetched on demand (via the parent-supplied `fetchMonth`) the first time the
// row is rendered/seeked; thumb URLs are batch-resolved per loaded month.
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { PhotoCard, type Asset } from "./photo-card";
import { TimelineScrubber, type ScrubBucket } from "./timeline-scrubber";
import { type Density } from "@/lib/hooks/use-toolbar-state";
import { segmentEventsByGap, eventGapMs } from "@/lib/events/segment";

const HEADER_HEIGHT_PX = 44;
const TILE_GAP_PX = 4; // matches `gap-1`
const SECTION_PADDING_PX = 24;
const BATCH_URL_CHUNK = 250;

// Column count per density × responsive width. Mirrors AssetGrid.columnsFor
// so the density zoom behaves identically on the timeline and the flat grid.
function columnsFor(density: Density, width: number): number {
  if (width < 480) return density === "dense" ? 4 : density === "compact" ? 3 : 2;
  if (width < 768) return density === "dense" ? 6 : density === "compact" ? 4 : 3;
  if (width < 1280) return density === "dense" ? 8 : density === "compact" ? 6 : 4;
  return density === "dense" ? 10 : density === "compact" ? 8 : 6;
}

function monthLabel(month: string): string {
  if (month === "undated") return "Undated";
  const [y, m] = month.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export interface TimelineMonth {
  month: string; // YYYY-MM
  count: number;
}

export interface VirtualizedTimelineProps {
  /** Full-library month buckets, newest first. */
  buckets: TimelineMonth[];
  /** Loads one month's assets (captured-date order). Identity changes when the
   *  active filters change — that resets the per-month cache. */
  fetchMonth: (month: string) => Promise<Asset[]>;
  onAssetClick: (asset: Asset) => void;
  /** Flattened loaded assets in timeline order — lets the parent drive a
   *  lightbox with prev/next over what's currently loaded. */
  onLoadedAssetsChange?: (assets: Asset[]) => void;
  /** Selection wiring — when selectMode is on, tile clicks toggle selection
   *  instead of opening the lightbox (PhotoCard handles the branch). */
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (assetId: string, e?: ReactMouseEvent) => void;
  /** Grid density (zoom). Drives column count; defaults to comfortable. */
  density?: Density;
  /** Task 20 (Phase 4) — when true, split each month's assets into inline
   *  event sub-sections (gap-based) with a date/time header. Gated to the
   *  Moments lens by the parent; the "Undated" bucket is never grouped. */
  groupByEvents?: boolean;
}

// Event header label from an event's [startAt, endAt] epoch-ms span. Same-day
// events show a time (or time range, disambiguating multiple events the same
// day); multi-day events (gap-merged overnight) show a date range.
function eventHeaderLabel(startAt: number, endAt: number): { date: string; detail: string } {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (s.toDateString() === e.toDateString()) {
    const date = e.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const detail = startAt === endAt ? fmtTime(s) : `${fmtTime(s)} – ${fmtTime(e)}`;
    return { date, detail };
  }
  const dm = { month: "short", day: "numeric" } as const;
  return {
    date: `${s.toLocaleDateString(undefined, dm)} – ${e.toLocaleDateString(undefined, dm)}`,
    detail: "",
  };
}

export function VirtualizedTimeline({
  buckets,
  fetchMonth,
  onAssetClick,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  onLoadedAssetsChange,
  density = "comfortable",
  groupByEvents = false,
}: VirtualizedTimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // The timeline owns its scroll container (with the native scrollbar hidden)
  // rather than riding AppShell's <main>. That kills the "two scrollbars"
  // problem — only the custom scrubber shows on the right — and lets the
  // scrubber drive scrolling directly.
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1024);
  // Column count tracks the live container width × density zoom. Memoised so
  // the height math and the rendered grid always agree on `cols`.
  const cols = useMemo(
    () => columnsFor(density, containerWidth),
    [density, containerWidth]
  );

  // Per-month asset cache + in-flight guard. Reset when fetchMonth identity
  // changes (i.e. filters changed).
  const [loaded, setLoaded] = useState<Map<string, Asset[]>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const scrubbingRef = useRef(false);

  useEffect(() => {
    setLoaded(new Map());
    inFlightRef.current = new Set();
  }, [fetchMonth]);

  // Track container width (for square-tile height estimate) + column count.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const tilePx = useMemo(() => {
    const usable = containerWidth - (cols - 1) * TILE_GAP_PX;
    return Math.max(64, Math.floor(usable / cols));
  }, [containerWidth, cols]);

  const estimateMonthSize = useCallback(
    (index: number) => {
      const b = buckets[index];
      if (!b) return HEADER_HEIGHT_PX;
      const rows = Math.max(1, Math.ceil(b.count / cols));
      return (
        HEADER_HEIGHT_PX + rows * tilePx + (rows - 1) * TILE_GAP_PX + SECTION_PADDING_PX
      );
    },
    [buckets, cols, tilePx]
  );

  const virtualizer = useVirtualizer({
    count: buckets.length,
    getScrollElement: () => scrollElRef.current,
    estimateSize: estimateMonthSize,
    overscan: 2,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Re-measure when layout-affecting inputs change.
  useEffect(() => {
    virtualizer.measure();
  }, [cols, tilePx, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  // Lazy-load the months currently in view + a ±1 prefetch ring so the
  // assets arrive BEFORE the row scrolls into the viewport. Skip while
  // actively scrubbing so a fling doesn't fetch every passed month; the
  // scrub-end handler backfills via virtualizer.measure().
  useEffect(() => {
    if (scrubbingRef.current) return;
    if (!virtualItems.length) return;
    const minIdx = Math.max(0, virtualItems[0].index - 1);
    const maxIdx = Math.min(
      buckets.length - 1,
      virtualItems[virtualItems.length - 1].index + 1
    );
    for (let i = minIdx; i <= maxIdx; i++) {
      const b = buckets[i];
      if (!b) continue;
      if (loaded.has(b.month) || inFlightRef.current.has(b.month)) continue;
      inFlightRef.current.add(b.month);
      void fetchMonth(b.month)
        .then((assets) => {
          setLoaded((prev) => {
            const next = new Map(prev);
            next.set(b.month, assets);
            return next;
          });
        })
        .catch(() => {
          setLoaded((prev) => {
            const next = new Map(prev);
            next.set(b.month, []);
            return next;
          });
        })
        .finally(() => inFlightRef.current.delete(b.month));
    }
  }, [virtualItems, buckets, loaded, fetchMonth]);

  // Surface flattened loaded assets (timeline order) for the parent lightbox.
  useEffect(() => {
    if (!onLoadedAssetsChange) return;
    const flat: Asset[] = [];
    for (const b of buckets) {
      const monthAssets = loaded.get(b.month);
      if (monthAssets) flat.push(...monthAssets);
    }
    onLoadedAssetsChange(flat);
  }, [loaded, buckets, onLoadedAssetsChange]);

  // Batch thumb URLs across every loaded asset.
  const loadedIds = useMemo(() => {
    const ids: string[] = [];
    for (const arr of loaded.values()) for (const a of arr) ids.push(a.id);
    return ids;
  }, [loaded]);
  const thumbUrls = useBatchThumbUrls(loadedIds);

  // Active (top-of-viewport) month for the scrubber + sticky chip.
  const activeMonth = virtualItems[0] != null ? buckets[virtualItems[0].index]?.month ?? null : null;

  // Live scroll fraction (0..1) of the scroll container, so the scrubber thumb
  // tracks scrolling smoothly — including within a single huge month.
  const [scrollFrac, setScrollFrac] = useState(0);
  useEffect(() => {
    const el = scrollElRef.current;
    if (!el) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      setScrollFrac(max > 0 ? el.scrollTop / max : 0);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [buckets.length]);

  // Drag-to-scrub: map a 0..1 fraction straight onto the scroll container's
  // scroll range. Continuous, so the timeline scrolls as the thumb moves.
  const scrubToFraction = useCallback((fraction: number) => {
    const el = scrollElRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.min(1, Math.max(0, fraction)) * max;
  }, []);

  const handleScrubStateChange = useCallback((scrubbing: boolean) => {
    scrubbingRef.current = scrubbing;
    // When the fling ends, nudge a re-render so the view-in lazy-load effect
    // runs against the months that settled into view.
    if (!scrubbing) virtualizer.measure();
  }, [virtualizer]);

  const totalSize = virtualizer.getTotalSize();

  const scrubBuckets: ScrubBucket[] = buckets;

  return (
    // ARIA: not a strict role=grid (mixes a scroll container + scrubber as
    // siblings; the real "rows" live three layers deeper). role=region with
    // a name describes the surface honestly and avoids Lighthouse's
    // aria-required-children fail.
    <div className="relative flex gap-2" role="region" aria-label="Asset timeline">
      {/* Own scroll container — native scrollbar hidden so the custom scrubber
          is the only thing on the right edge. Height fills the viewport below
          the toolbar + chip strip. */}
      <div
        ref={scrollElRef}
        className="relative h-[calc(100dvh-12rem)] min-w-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {activeMonth && (
          // Hidden on mobile: the per-section <h2> headers + the now-visible
          // scrubber's drag-label already supply date context there, so the
          // floating pill would just duplicate the section header. Desktop
          // keeps it for mid-section context while mouse-scrolling.
          <div className="pointer-events-none sticky top-2 z-20 mb-1 hidden md:flex">
            <div className="pointer-events-auto rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur-sm">
              {monthLabel(activeMonth)}
            </div>
          </div>
        )}
        <div ref={parentRef} style={{ height: `${totalSize}px`, width: "100%", position: "relative" }}>
            {virtualItems.map((virtualRow) => {
              const b = buckets[virtualRow.index];
              if (!b) return null;
              const monthAssets = loaded.get(b.month);
              const rows = Math.max(1, Math.ceil(b.count / cols));
              const reservedGridHeight = rows * tilePx + (rows - 1) * TILE_GAP_PX;
              return (
                <div
                  key={b.month}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
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
                      {monthLabel(b.month)}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      · {b.count} {b.count === 1 ? "item" : "items"}
                    </span>
                  </div>

                  {monthAssets ? (
                    groupByEvents && b.month !== "undated" ? (
                      segmentEventsByGap(monthAssets, eventGapMs()).map((ev, evIdx) => {
                        const { date, detail } = eventHeaderLabel(ev.startAt, ev.endAt);
                        return (
                          <div key={ev.key} className={evIdx > 0 ? "mt-4" : undefined}>
                            <div className="mb-1.5 flex items-baseline gap-2 px-1">
                              <h3 className="text-sm font-medium text-foreground">{date}</h3>
                              {detail && (
                                <span className="text-xs text-muted-foreground">{detail}</span>
                              )}
                              <span className="text-xs text-muted-foreground">
                                · {ev.assets.length} {ev.assets.length === 1 ? "item" : "items"}
                              </span>
                            </div>
                            <div
                              className="grid gap-1"
                              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                            >
                              {ev.assets.map((asset) => (
                                <PhotoCard
                                  key={asset.id}
                                  asset={asset}
                                  thumbUrl={thumbUrls[asset.id]}
                                  showQuickActions
                                  selectMode={selectMode}
                                  selected={selectedIds?.has(asset.id) ?? false}
                                  onSelect={(e) => onToggleSelect?.(asset.id, e)}
                                  onClick={() => onAssetClick(asset)}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div
                        className="grid gap-1"
                        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                      >
                        {monthAssets.map((asset) => (
                          <PhotoCard
                            key={asset.id}
                            asset={asset}
                            thumbUrl={thumbUrls[asset.id]}
                            showQuickActions
                            selectMode={selectMode}
                            selected={selectedIds?.has(asset.id) ?? false}
                            onSelect={(e) => onToggleSelect?.(asset.id, e)}
                            onClick={() => onAssetClick(asset)}
                          />
                        ))}
                      </div>
                    )
                  ) : (
                    // Height-reserved skeleton so the scrollbar is accurate
                    // before the month's assets arrive.
                    <div
                      className="flex items-center justify-center rounded-md bg-muted/20"
                      style={{ height: reservedGridHeight }}
                    >
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
                    </div>
                  )}

                  <div style={{ height: SECTION_PADDING_PX }} aria-hidden="true" />
                </div>
              );
            })}
        </div>
      </div>

      <TimelineScrubber
        buckets={scrubBuckets}
        thumbFraction={scrollFrac}
        onScrubTo={scrubToFraction}
        onScrubStateChange={handleScrubStateChange}
      />
    </div>
  );
}

// Batched thumb-URL fetch — mirrors AssetGrid's helper but local to the
// timeline. Returns a stable {id: url|null} dict kept current with the loaded
// asset ids; already-known ids are never refetched.
function useBatchThumbUrls(ids: string[]): Record<string, string | null> {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  // `known` covers IDs that have been resolved (URL or null) AND IDs that
  // are currently being fetched. The ±1-month prefetch ring + multi-month
  // mounts otherwise re-fire the same POST every time `ids` grew, since
  // knownRef wasn't claimed until response time. Claim eagerly = de-dupe.
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (ids.length === 0) return;
    const missing = ids.filter((id) => !knownRef.current.has(id));
    if (missing.length === 0) return;

    // Mark missing IDs as claimed BEFORE the fetch so a re-render while
    // the request is in flight doesn't requeue the same chunk.
    for (const id of missing) knownRef.current.add(id);

    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_URL_CHUNK) {
      chunks.push(missing.slice(i, i + BATCH_URL_CHUNK));
    }

    (async () => {
      for (const chunk of chunks) {
        try {
          const r = await fetch("/api/v1/assets/urls", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: chunk, variant: "thumb" }),
          });
          if (!r.ok) continue;
          const d = (await r.json()) as { urls?: Record<string, string> };
          if (cancelled) return;
          setUrls((prev) => {
            const next = { ...prev };
            for (const id of chunk) next[id] = d.urls?.[id] ?? null;
            return next;
          });
        } catch {
          // ids stay claimed so we don't infinite-retry on a permanent
          // network fault; PhotoCard renders a placeholder if url is missing
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ids]);

  return urls;
}
