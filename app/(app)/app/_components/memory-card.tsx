// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.3 — "On this day" card for the dashboard.
//
// Renders a horizontal carousel of one thumbnail per prior year matching
// today's date (±MEMORIES_DAY_WINDOW). Clicking the card (or any tile)
// navigates to `/app/memories` for the full grouped view.
//
// Lives client-side because the surrounding dashboard page is itself a
// client component (`"use client"`); fetching from a server component would
// require restructuring the parent.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ImageIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

interface MemoryAsset {
  id: string;
  filename: string;
  mimeType: string;
  capturedAt: string | null;
}

interface MemoryYear {
  year: number;
  count: number;
  assets: MemoryAsset[];
}

function YearTile({ year, asset, count }: { year: number; asset: MemoryAsset; count: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) return;
    let cancelled = false;
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setUrl(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.mimeType]);

  const refYear = new Date().getFullYear();
  const diff = refYear - year;
  const label = diff === 1 ? "1y ago" : `${diff}y ago`;

  return (
    <Link
      href="/app/memories"
      className="relative shrink-0 overflow-hidden rounded-lg group"
      title={`${count} ${count === 1 ? "asset" : "assets"} from ${year}`}
    >
      <div className="h-32 w-32 bg-[var(--ft-color-surface-container)] flex items-center justify-center">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.filename}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <ImageIcon className="h-8 w-8 text-[var(--ft-color-on-surface-variant)]" />
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-white">
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[10px] text-white/80">
          {count} {count === 1 ? "photo" : "photos"}
        </div>
      </div>
    </Link>
  );
}

export function MemoryCard() {
  const [years, setYears] = useState<MemoryYear[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/memories")
      .then((r) => (r.ok ? r.json() : { years: [] }))
      .then((d: { years?: MemoryYear[] }) => {
        if (!cancelled) setYears(d.years ?? []);
      })
      .catch(() => {
        if (!cancelled) setYears([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide the card entirely when there's nothing to show — avoids the awkward
  // "On this day (nothing)" empty card on dashboards with sparse history.
  if (loading || years.length === 0) return null;

  return (
    // ADR 0009 phase 2 (group D) — MD3 filled card surface for the
    // dashboard "On this day" object. Tile layout and lazy-fetch inside
    // YearTile untouched; only the wrapper chrome + header typography
    // resolve through the --ft-* namespace now.
    <Card variant="filled" className="p-[var(--ft-space-4)]">
      <div className="mb-[var(--ft-space-3)] flex items-center justify-between">
        <div className="flex items-center gap-[var(--ft-space-2)]">
          <Sparkles className="h-4 w-4 text-[var(--ft-color-primary)]" />
          <h2 className="text-[length:var(--ft-type-title-small-size)] leading-[var(--ft-type-title-small-line)] font-semibold text-[var(--ft-color-on-surface)]">
            On this day
          </h2>
        </div>
        <Link
          href="/app/memories"
          className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-primary)] hover:underline"
        >
          View all
        </Link>
      </div>
      <div className="flex gap-[var(--ft-space-2)] overflow-x-auto pb-1">
        {years.map((y) => (
          <YearTile
            key={y.year}
            year={y.year}
            asset={y.assets[0]}
            count={y.count}
          />
        ))}
      </div>
    </Card>
  );
}
