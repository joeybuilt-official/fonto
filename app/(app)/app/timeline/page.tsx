// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 sweep: shared toolbar + grid. VirtualizedTimeline's month-grouping
// is dropped in v1 — AssetGrid virtualises at ≥500 rows and the audit's
// scrubber rail (year/month ticks) is a follow-up. Until then this is a
// flat chronological grid with q / sort / filter / select / ask.
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { ListErrorState } from "../_components/list-states";
import { AssetAskPanel } from "../_components/asset-ask-panel";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

function TimelineContent() {
  const toolbar = useToolbarState({
    page: "timeline",
    availableFilters: ["mime", "type", "favorite", "ratingMin"],
  });

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(false);
      const sp = new URLSearchParams();
      if (toolbar.filters.mime) sp.set("mime", toolbar.filters.mime);
      if (toolbar.filters.type) sp.set("subtype", toolbar.filters.type);
      if (toolbar.filters.favorite) sp.set("favorite", "1");
      if (toolbar.filters.ratingMin != null) sp.set("ratingMin", String(toolbar.filters.ratingMin));
      try {
        const r = await fetch(`/api/v1/assets?${sp.toString()}`);
        if (!r.ok) throw new Error(`assets ${r.status}`);
        const d = (await r.json()) as { assets?: Asset[] };
        let list = (d.assets ?? []) as Asset[];
        if (toolbar.filters.sort === "oldest") {
          list = [...list].sort(
            (a, b) =>
              new Date(a.capturedAt ?? a.createdAt).getTime() -
              new Date(b.capturedAt ?? b.createdAt).getTime()
          );
        } else if (toolbar.filters.sort === "name") {
          list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
        } else if (toolbar.filters.sort === "rating") {
          list = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        } else {
          list = [...list].sort(
            (a, b) =>
              new Date(b.capturedAt ?? b.createdAt).getTime() -
              new Date(a.capturedAt ?? a.createdAt).getTime()
          );
        }
        if (toolbar.filters.q) {
          const needle = toolbar.filters.q.toLowerCase();
          list = list.filter(
            (a) =>
              a.filename.toLowerCase().includes(needle) ||
              (a.description?.toLowerCase().includes(needle) ?? false)
          );
        }
        setAssets(list);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.sort,
    toolbar.filters.q,
    refreshKey,
  ]);

  const openLightbox = useCallback((_id: string, index: number) => {
    setLightboxIndex(index);
  }, []);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  function handleLightboxTrash(assetId: string) {
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
    setLightboxIndex(null);
  }

  // Bubble favorite/rating mutations from the lightbox into the timeline so
  // grid badges (heart, star count) update without a round-trip.
  const handleAssetUpdate = useCallback(
    (assetId: string, patch: { isFavorite?: boolean; rating?: number }) => {
      setAssets((prev) =>
        prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a))
      );
    },
    []
  );

  function askContextIds(): string[] {
    if (toolbar.selectedIds.size > 0) return Array.from(toolbar.selectedIds).slice(0, 200);
    return assets.slice(0, 200).map((a) => a.id);
  }

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Timeline"
        count={loading ? undefined : assets.length}
        toolbar={toolbar}
        searchPlaceholder="Search timeline…"
        sortOptions={["newest", "oldest", "name", "rating"]}
        filterKeys={["mime", "type", "favorite", "ratingMin"]}
        showDensity
        showSelect
        onAskAI={() => setAskOpen(true)}
        getAskContextIds={askContextIds}
      />

      {error ? (
        <ListErrorState
          message="Couldn't load your timeline. Check your connection and retry."
          onRetry={() => setRefreshKey((k) => k + 1)}
        />
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading timeline…
        </div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Clock className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No assets match the current filters.
          </p>
        </div>
      ) : (
        <div className="px-4">
          <AssetGrid
            assets={assets}
            toolbar={toolbar}
            viewMode="grid"
            onAssetClick={openLightbox}
          />
        </div>
      )}

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <PhotoLightbox
          asset={assets[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
          onTrash={handleLightboxTrash}
          onAssetUpdate={handleAssetUpdate}
        />
      )}

      <AssetAskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        contextAssetIds={askContextIds()}
        contextLabel={`${assets.length} asset${assets.length === 1 ? "" : "s"}`}
      />
    </div>
  );
}

export default function TimelinePage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <TimelineContent />
    </Suspense>
  );
}
