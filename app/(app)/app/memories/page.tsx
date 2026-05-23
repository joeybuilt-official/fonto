// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.3 — Memories ("On this day") detail page.
//
// Defaults to today. The date picker re-queries `/api/v1/memories?date=...`.
// Each year is rendered as its own section with a "N years ago — Mon DD, YYYY"
// header and a grid of thumbnails. Empty state shows a friendly hint.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Calendar as CalendarIcon, ImageIcon } from "lucide-react";

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

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatMonthDay(date: string): string {
  // date is YYYY-MM-DD; we only show the MM-DD portion in the section
  // headers since the year varies per section.
  const [, mm, dd] = date.split("-");
  const month = new Date(2000, Number(mm) - 1, 1).toLocaleString(undefined, {
    month: "long",
  });
  return `${month} ${Number(dd)}`;
}

function yearsAgo(year: number, refDate: string): string {
  const refYear = Number(refDate.slice(0, 4));
  const diff = refYear - year;
  if (diff <= 0) return "This year";
  if (diff === 1) return "1 year ago";
  return `${diff} years ago`;
}

function AssetTile({ asset }: { asset: MemoryAsset }) {
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

  return (
    <div className="aspect-square overflow-hidden rounded-lg bg-muted/30 flex items-center justify-center relative">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={asset.filename}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <ImageIcon className="h-8 w-8 text-muted-foreground" />
      )}
    </div>
  );
}

export default function MemoriesPage() {
  const [date, setDate] = useState<string>(todayISO());
  const [years, setYears] = useState<MemoryYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/memories?date=${d}`);
      if (!res.ok) {
        setError(`Failed to load memories (${res.status}).`);
        setYears([]);
        return;
      }
      const data = (await res.json()) as { years: MemoryYear[] };
      setYears(data.years ?? []);
    } catch {
      setError("Network error loading memories.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  const headline = useMemo(() => formatMonthDay(date), [date]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Memories</h1>
          <p className="text-sm text-muted-foreground mt-1">
            On this day — {headline}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarIcon className="h-4 w-4" />
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground">Loading memories…</p>
      )}

      {error && !loading && (
        <p className="text-sm text-red-500">{error}</p>
      )}

      {!loading && !error && years.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No memories from {headline} in prior years yet.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload photos with capture dates to start building memories.
          </p>
        </div>
      )}

      {years.map((y) => (
        <section key={y.year} className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-foreground">
              {yearsAgo(y.year, date)}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {headline}, {y.year}
              </span>
            </h2>
            <span className="text-xs text-muted-foreground">
              {y.count} {y.count === 1 ? "asset" : "assets"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8">
            {y.assets.map((asset) => (
              <AssetTile key={asset.id} asset={asset} />
            ))}
          </div>
        </section>
      ))}

    </div>
  );
}
