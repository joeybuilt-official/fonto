// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 — fast date scrubber for the seekable timeline.
//
// A draggable thumb on the right edge whose position is proportional to the
// cumulative asset count above each month (so the whole library — not just
// loaded months — is represented). While dragging, a floating bubble tracks
// the pointer and shows the month/year under it, updating ~30 fps; the actual
// timeline seek fires on release (or on a slow-drag dwell) via `onSeek`.
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface ScrubBucket {
  month: string; // "YYYY-MM"
  count: number;
}

function formatMonth(month: string): string {
  if (month === "undated") return "Undated";
  const [y, m] = month.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatYear(month: string): string {
  return month.slice(0, 4);
}

interface TimelineScrubberProps {
  /** Full-library month buckets, newest first. Drives the scrubber domain. */
  buckets: ScrubBucket[];
  /** Live scroll position of the timeline as a 0..1 fraction. Positions the
   *  thumb when idle so the scrubber tracks scrolling like a real scrollbar —
   *  including within a single huge month, where a month-boundary thumb would
   *  sit frozen. */
  thumbFraction: number;
  /** Scroll the timeline so this 0..1 fraction is at the top. Fired live
   *  while dragging the thumb. */
  onScrubTo: (fraction: number) => void;
  /** Fired on drag start/end so the timeline can gate lazy month fetches
   *  while the user is flinging through the scrubber. */
  onScrubStateChange?: (scrubbing: boolean) => void;
}

export function TimelineScrubber({
  buckets,
  thumbFraction,
  onScrubTo,
  onScrubStateChange,
}: TimelineScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Current drag fraction (0..1) — positions the thumb while dragging.
  const [dragFrac, setDragFrac] = useState(0);

  // Cumulative count *above* each bucket + the grand total. Used to map a
  // fractional track position to a month and vice-versa.
  const { cumBefore, total } = useMemo(() => {
    const cum: number[] = [];
    let running = 0;
    for (const b of buckets) {
      cum.push(running);
      running += Math.max(0, b.count);
    }
    return { cumBefore: cum, total: running };
  }, [buckets]);

  // Sparse year labels along the track for orientation (first month of each
  // distinct year, deduped, then thinned so labels don't overlap when one
  // year dominates the cumulative count — eg. a library w/ 24 items in 2026
  // but 8000 in 2014 would otherwise stack 2026/25/24/23/22/21/20 in the
  // first ~3% of the track).
  const yearTicks = useMemo(() => {
    const raw: { year: string; frac: number }[] = [];
    let lastYear = "";
    buckets.forEach((b, i) => {
      if (b.month === "undated") return;
      const y = formatYear(b.month);
      if (y !== lastYear) {
        raw.push({ year: y, frac: total > 0 ? cumBefore[i] / total : 0 });
        lastYear = y;
      }
    });
    // 9px font + tabular nums ~= 11px tall. 4% gap @ 600px track = 24px.
    // Drops the cramped middle years, keeps endpoints (newest + oldest).
    const MIN_GAP = 0.04;
    const thinned: { year: string; frac: number }[] = [];
    for (const t of raw) {
      const prev = thinned[thinned.length - 1];
      if (!prev || t.frac - prev.frac >= MIN_GAP) thinned.push(t);
    }
    // Always preserve the oldest-year tick — without this it can fall off
    // the bottom of the track when its neighbour above is < MIN_GAP away.
    const last = raw[raw.length - 1];
    if (last && thinned[thinned.length - 1]?.year !== last.year) {
      const prev = thinned[thinned.length - 1];
      if (!prev || last.frac - prev.frac >= MIN_GAP / 2) thinned.push(last);
    }
    return thinned;
  }, [buckets, cumBefore, total]);

  const monthAtFraction = useCallback(
    (frac: number): string | null => {
      if (buckets.length === 0 || total === 0) return buckets[0]?.month ?? null;
      const target = Math.min(total - 1, Math.max(0, frac * total));
      // Binary search for the bucket whose [cumBefore, cumBefore+count) span
      // contains `target`.
      let lo = 0;
      let hi = buckets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumBefore[mid] <= target) lo = mid;
        else hi = mid - 1;
      }
      return buckets[lo].month;
    },
    [buckets, cumBefore, total]
  );

  // Thumb position (fraction 0..1): the live drag fraction while dragging,
  // otherwise the timeline's actual scroll fraction so it tracks scrolling
  // smoothly even through one giant month.
  const thumbFrac = dragging ? dragFrac : Math.min(1, Math.max(0, thumbFraction));

  const updateFromClientY = useCallback(
    (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const y = Math.min(rect.height, Math.max(0, clientY - rect.top));
      const frac = rect.height > 0 ? y / rect.height : 0;
      setDragFrac(frac);

      // Scroll the timeline live to this fraction — this is what makes the
      // scrubber behave like a real scrollbar instead of a tap-to-jump.
      onScrubTo(frac);
    },
    [onScrubTo]
  );

  const endDrag = useCallback(() => {
    setDragging(false);
    onScrubStateChange?.(false);
  }, [onScrubStateChange]);

  // Pointer drag — attached to window during a drag so the gesture survives
  // the pointer leaving the narrow track.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      updateFromClientY(e.clientY);
    };
    const up = (e: PointerEvent) => {
      updateFromClientY(e.clientY);
      endDrag();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragging, updateFromClientY, endDrag]);

  if (buckets.length <= 1) return null;

  const labelMonth = monthAtFraction(thumbFrac);

  return (
    <div
      className="sticky top-0 h-[calc(100dvh-12rem)] w-12 shrink-0 select-none self-start"
      aria-hidden={false}
    >
      <div
        ref={trackRef}
        role="slider"
        aria-label="Scrub timeline by date"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(thumbFrac * 100)}
        aria-valuetext={labelMonth ? formatMonth(labelMonth) : undefined}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          onScrubStateChange?.(true);
          updateFromClientY(e.clientY);
        }}
        onKeyDown={(e) => {
          // Arrow / PageUp-Down nudge the scroll fraction; Home/End jump to
          // the newest/oldest end.
          const step = e.key === "PageDown" || e.key === "PageUp" ? 0.1 : 0.02;
          if (e.key === "ArrowDown" || e.key === "PageDown") {
            e.preventDefault();
            onScrubTo(Math.min(1, thumbFrac + step));
          } else if (e.key === "ArrowUp" || e.key === "PageUp") {
            e.preventDefault();
            onScrubTo(Math.max(0, thumbFrac - step));
          } else if (e.key === "Home") {
            e.preventDefault();
            onScrubTo(0);
          } else if (e.key === "End") {
            e.preventDefault();
            onScrubTo(1);
          }
        }}
        className="relative h-full w-full cursor-pointer touch-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {/* Year tick labels. Sit left of the thumb track so the thumb doesn't
            visually cover them when at fraction=0 or fraction=1 (right-1 +
            thumb at right-0 collided at the year endpoints). Color uses
            `text-foreground/70` (~6.2:1) instead of muted-foreground/70
            (~2.7:1) so the 9px year labels meet WCAG AA. */}
        {yearTicks.map((t) => (
          <span
            key={t.year}
            className="pointer-events-none absolute right-3 -translate-y-1/2 text-[9px] font-medium tabular-nums text-foreground/70"
            style={{ top: `${t.frac * 100}%` }}
          >
            {t.year}
          </span>
        ))}

        {/* Thumb */}
        <div
          className="pointer-events-none absolute right-0 h-6 w-1.5 -translate-y-1/2 rounded-full bg-primary transition-[top] duration-75"
          style={{ top: `${thumbFrac * 100}%` }}
        />
      </div>

      {/* Floating bubble — shows the date under the thumb while dragging.
          Positioned by the live thumb fraction (not throttled state) so it
          appears immediately on touch and tracks the drag on every platform. */}
      {dragging && labelMonth && (
        <div
          className="pointer-events-none absolute right-10 z-30 -translate-y-1/2 whitespace-nowrap rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-background shadow-lg"
          style={{ top: `${thumbFrac * 100}%` }}
        >
          {formatMonth(labelMonth)}
        </div>
      )}
    </div>
  );
}
