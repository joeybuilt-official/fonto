// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.3 — Memories ("On this day") detail page.
//
// UX-3 sweep: shares AssetPageToolbar + AssetGrid across all year sections.
// Toolbar drives q/sort/select; selection spans years so the bulk-action
// bar can act on a multi-year set. Date picker lives in the primaryAction
// slot. Year-jump rail per audit §4 is deferred.
"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { Calendar as CalendarIcon, ImageIcon } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { AssetAskPanel } from "../_components/asset-ask-panel";
import { ListErrorState } from "../_components/list-states";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

interface MemoryYear {
  year: number;
  count: number;
  assets: Asset[];
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatMonthDay(date: string): string {
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

function MemoriesContent() {
  const toolbar = useToolbarState({
    page: "memories",
    availableFilters: ["favorite", "ratingMin"],
  });

  // Initialised empty so the server and the first client render agree
  // (todayISO() reads the local clock, which diverges across the SSR/CSR
  // boundary and throws React #418). The real date is set after mount.
  const [date, setDate] = useState<string>("");
  const [years, setYears] = useState<MemoryYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setDate(todayISO());
  }, []);

  useEffect(() => {
    if (!date) return;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/memories?date=${date}`);
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
    })();
  }, [date, refreshKey]);

  const headline = useMemo(() => (date ? formatMonthDay(date) : "today"), [date]);
  const totalCount = years.reduce((sum, y) => sum + y.count, 0);

  // Client-side q / sort filtering per year, since the memories endpoint
  // doesn't accept those today. Each year's filtered list rolls up to
  // visibleTotal so the toolbar count reflects the filter result.
  const visibleYears = useMemo<MemoryYear[]>(() => {
    return years.map((y) => {
      let list = y.assets;
      if (toolbar.filters.favorite) {
        list = list.filter((a) => a.isFavorite);
      }
      if (toolbar.filters.ratingMin != null) {
        list = list.filter((a) => (a.rating ?? 0) >= toolbar.filters.ratingMin!);
      }
      if (toolbar.filters.q) {
        const needle = toolbar.filters.q.toLowerCase();
        list = list.filter(
          (a) =>
            a.filename.toLowerCase().includes(needle) ||
            (a.description?.toLowerCase().includes(needle) ?? false)
        );
      }
      if (toolbar.filters.sort === "name") {
        list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
      } else if (toolbar.filters.sort === "rating") {
        list = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      }
      return { ...y, assets: list, count: list.length };
    });
  }, [years, toolbar.filters.favorite, toolbar.filters.ratingMin, toolbar.filters.q, toolbar.filters.sort]);

  const visibleTotal = visibleYears.reduce((s, y) => s + y.count, 0);

  function askContextIds(): string[] {
    if (toolbar.selectedIds.size > 0) return Array.from(toolbar.selectedIds).slice(0, 200);
    const all: string[] = [];
    for (const y of visibleYears) {
      for (const a of y.assets) {
        if (all.length >= 200) break;
        all.push(a.id);
      }
    }
    return all;
  }

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Memories"
        count={loading ? undefined : visibleTotal}
        toolbar={toolbar}
        searchPlaceholder={`Search ${headline}…`}
        sortOptions={["newest", "name", "rating"]}
        filterKeys={["favorite", "ratingMin"]}
        showDensity
        showSelect
        onAskAI={() => setAskOpen(true)}
        getAskContextIds={askContextIds}
        primaryAction={{
          label: headline,
          icon: <CalendarIcon className="h-3.5 w-3.5" />,
          variant: "outline",
          onClick: () => {
            // Toolbar buttons render as buttons, so the date picker can't be
            // a child input directly — instead clicking opens the native
            // picker on the hidden <input> below.
            const input = document.getElementById("memories-date") as HTMLInputElement | null;
            input?.showPicker?.();
          },
        }}
      />

      {/* Hidden picker driven by the primaryAction button click. Lives
          outside the toolbar so it doesn't disrupt the sticky layout. */}
      <input
        id="memories-date"
        type="date"
        aria-label="Pick the day to view memories from"
        value={date}
        onChange={(e) => e.target.value && setDate(e.target.value)}
        className="sr-only"
      />

      <div className="px-4 space-y-6">
        {loading && (
          <p className="text-sm text-muted-foreground">Loading memories…</p>
        )}

        {error && !loading && (
          <ListErrorState
            message={error}
            onRetry={() => setRefreshKey((k) => k + 1)}
          />
        )}

        {!loading && !error && totalCount === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No memories from {headline} in prior years yet.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload photos with capture dates to start building memories.
            </p>
          </div>
        )}

        {!loading && !error && totalCount > 0 && visibleTotal === 0 && (
          <p className="text-sm text-muted-foreground">
            No matches for the current filters.
          </p>
        )}

        {visibleYears.map((y) =>
          y.assets.length === 0 ? null : (
            <section key={y.year} className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="font-heading text-base font-semibold text-foreground">
                  {yearsAgo(y.year, date)}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    — {headline}, {y.year}
                  </span>
                </h2>
                <span className="text-xs text-muted-foreground">
                  {y.count} {y.count === 1 ? "asset" : "assets"}
                </span>
              </div>
              <AssetGrid
                assets={y.assets}
                toolbar={toolbar}
                viewMode="grid"
                density={toolbar.view.density}
                emptyState={
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ImageIcon className="h-4 w-4" /> No items
                  </div>
                }
              />
            </section>
          )
        )}
      </div>

      <AssetAskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        contextAssetIds={askContextIds()}
        contextLabel={`memories from ${headline} (${visibleTotal})`}
      />
    </div>
  );
}

export default function MemoriesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <MemoriesContent />
    </Suspense>
  );
}
