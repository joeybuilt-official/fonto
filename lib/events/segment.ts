// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Task 20 (Phase 4) — Events synthesis, COMPUTED v1.
//
// Pure, client-side gap segmentation: split an already-capture-ordered run of
// assets into "events" wherever the capture-time gap between neighbours exceeds
// a threshold (default 3h). An event is a logical outing/session — "Saturday
// morning at the park" vs "Saturday evening dinner" become two events the same
// day because of the gap between them. No ML, no endpoint, no table (ADR D2 =
// computed; D2.1 = inline gap-split). The timeline feeds each loaded month's
// assets through this to render inline event sub-headers.

export interface TimelineEvent<T> {
  /** Stable key — the first (newest) member's id. */
  key: string;
  /** Members, in the same order they arrived (capture-desc within a month). */
  assets: T[];
  /** Epoch ms of the earliest and latest member's capture/created time. */
  startAt: number;
  endAt: number;
}

export interface SegmentableAsset {
  id: string;
  capturedAt: string | null;
  createdAt: string;
}

const DEFAULT_GAP_HOURS = 3;

/** Resolve the configured gap window (ms). Client-readable env override. */
export function eventGapMs(): number {
  const raw = process.env.NEXT_PUBLIC_EVENT_GAP_HOURS;
  const n = raw ? Number(raw) : DEFAULT_GAP_HOURS;
  const hours = Number.isFinite(n) && n > 0 ? n : DEFAULT_GAP_HOURS;
  return hours * 60 * 60 * 1000;
}

function assetTime(a: SegmentableAsset): number {
  return new Date(a.capturedAt ?? a.createdAt).getTime();
}

/**
 * Segment a capture-ordered asset list into events by capture-time gap.
 *
 * Input is expected newest-first (the timeline's per-month order). A new event
 * begins whenever the gap between consecutive members exceeds `gapMs`. Order is
 * preserved; every input asset lands in exactly one event (no drops, no dupes).
 */
export function segmentEventsByGap<T extends SegmentableAsset>(
  assets: T[],
  gapMs: number
): TimelineEvent<T>[] {
  if (assets.length === 0) return [];

  const events: TimelineEvent<T>[] = [];
  let current: T[] = [assets[0]];

  for (let i = 1; i < assets.length; i++) {
    const prev = assetTime(assets[i - 1]);
    const cur = assetTime(assets[i]);
    // Newest-first ⇒ prev is the later timestamp; gap is prev - cur.
    if (Math.abs(prev - cur) > gapMs) {
      events.push(toEvent(current));
      current = [assets[i]];
    } else {
      current.push(assets[i]);
    }
  }
  events.push(toEvent(current));
  return events;
}

function toEvent<T extends SegmentableAsset>(members: T[]): TimelineEvent<T> {
  let startAt = Infinity;
  let endAt = -Infinity;
  for (const m of members) {
    const t = assetTime(m);
    if (t < startAt) startAt = t;
    if (t > endAt) endAt = t;
  }
  return { key: members[0].id, assets: members, startAt, endAt };
}
