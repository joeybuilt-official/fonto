// SPDX-License-Identifier: AGPL-3.0-only
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
  /** Month currently at the top of the viewport — positions the thumb when
   *  the user isn't actively dragging. */
  activeMonth: string | null;
  /** Fired when the user releases (or dwells) on a month — seek the timeline. */
  onSeek: (month: string) => void;
  /** Fired on drag start/end so the timeline can gate lazy month fetches
   *  while the user is flinging through the scrubber. */
  onScrubStateChange?: (scrubbing: boolean) => void;
}

export function TimelineScrubber({
  buckets,
  activeMonth,
  onSeek,
  onScrubStateChange,
}: TimelineScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Bubble state: the month under the pointer + the pointer Y (px from track top).
  const [bubble, setBubble] = useState<{ month: string; y: number } | null>(null);
  // Throttle bubble updates to ~30 fps.
  const lastBubbleAtRef = useRef(0);
  // Throttle live scroll-follow seeks during a drag (~14 fps is plenty for
  // month-granularity scrolling and keeps scrollToIndex from thrashing).
  const lastSeekAtRef = useRef(0);

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
  // distinct year, deduped, capped so a 20-year library doesn't crowd).
  const yearTicks = useMemo(() => {
    const ticks: { year: string; frac: number }[] = [];
    let lastYear = "";
    buckets.forEach((b, i) => {
      const y = formatYear(b.month);
      if (y !== lastYear) {
        ticks.push({ year: y, frac: total > 0 ? cumBefore[i] / total : 0 });
        lastYear = y;
      }
    });
    return ticks;
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

  // Thumb position (fraction 0..1) reflecting the active month when idle, or
  // the live bubble target while dragging.
  const thumbFrac = useMemo(() => {
    if (dragging && bubble) {
      const idx = buckets.findIndex((b) => b.month === bubble.month);
      if (idx >= 0 && total > 0) return cumBefore[idx] / total;
    }
    if (activeMonth) {
      const idx = buckets.findIndex((b) => b.month === activeMonth);
      if (idx >= 0 && total > 0) return cumBefore[idx] / total;
    }
    return 0;
  }, [dragging, bubble, activeMonth, buckets, cumBefore, total]);

  const updateFromClientY = useCallback(
    (clientY: number, seekImmediately: boolean) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const y = Math.min(rect.height, Math.max(0, clientY - rect.top));
      const frac = rect.height > 0 ? y / rect.height : 0;
      const month = monthAtFraction(frac);
      if (!month) return;

      const now = performance.now();
      if (seekImmediately || now - lastBubbleAtRef.current >= 33) {
        lastBubbleAtRef.current = now;
        setBubble({ month, y });
      }

      if (seekImmediately) {
        onSeek(month);
        return;
      }

      // Live-follow: scroll the timeline as the thumb moves (throttled so a
      // fling doesn't fire scrollToIndex on every pointermove). This is what
      // makes the scrubber feel like a scrollbar instead of a tap-to-jump.
      if (now - lastSeekAtRef.current >= 70) {
        lastSeekAtRef.current = now;
        onSeek(month);
      }
    },
    [monthAtFraction, onSeek]
  );

  const endDrag = useCallback(() => {
    setDragging(false);
    setBubble(null);
    onScrubStateChange?.(false);
  }, [onScrubStateChange]);

  // Pointer drag — attached to window during a drag so the gesture survives
  // the pointer leaving the narrow track.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      updateFromClientY(e.clientY, false);
    };
    const up = (e: PointerEvent) => {
      updateFromClientY(e.clientY, true);
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

  const TRACK_LABEL_ACTIVE = bubble?.month ?? activeMonth;

  return (
    <div
      className="sticky top-0 hidden h-[calc(100dvh-8rem)] w-12 shrink-0 select-none self-start md:block"
      aria-hidden={false}
    >
      <div
        ref={trackRef}
        role="slider"
        aria-label="Scrub timeline by date"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, buckets.length - 1)}
        aria-valuenow={
          TRACK_LABEL_ACTIVE
            ? Math.max(0, buckets.findIndex((b) => b.month === TRACK_LABEL_ACTIVE))
            : 0
        }
        aria-valuetext={TRACK_LABEL_ACTIVE ? formatMonth(TRACK_LABEL_ACTIVE) : undefined}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          onScrubStateChange?.(true);
          updateFromClientY(e.clientY, false);
        }}
        onKeyDown={(e) => {
          if (!activeMonth) return;
          const idx = buckets.findIndex((b) => b.month === activeMonth);
          if (idx < 0) return;
          if (e.key === "ArrowDown" || e.key === "PageDown") {
            e.preventDefault();
            onSeek(buckets[Math.min(buckets.length - 1, idx + 1)].month);
          } else if (e.key === "ArrowUp" || e.key === "PageUp") {
            e.preventDefault();
            onSeek(buckets[Math.max(0, idx - 1)].month);
          } else if (e.key === "Home") {
            e.preventDefault();
            onSeek(buckets[0].month);
          } else if (e.key === "End") {
            e.preventDefault();
            onSeek(buckets[buckets.length - 1].month);
          }
        }}
        className="relative h-full w-full cursor-pointer rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {/* Year tick labels */}
        {yearTicks.map((t) => (
          <span
            key={t.year}
            className="pointer-events-none absolute right-1 -translate-y-1/2 text-[9px] font-medium tabular-nums text-muted-foreground/70"
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

      {/* Floating bubble — follows the pointer during a drag. */}
      {dragging && bubble && (
        <div
          className="pointer-events-none absolute right-10 z-30 -translate-y-1/2 whitespace-nowrap rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-background shadow-lg"
          style={{ top: `${bubble.y}px` }}
        >
          {formatMonth(bubble.month)}
        </div>
      )}
    </div>
  );
}
