// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Loader2, Heart, Star } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { VirtualizedTimeline } from "../_components/virtualized-timeline";

// Phase 3.4 — favorites + 4+ rating chips augment the existing mime chips.
// The fetch URL is derived from the full filter set so the cache key in
// `data.filter` discriminates correctly when only the facet changes.
type Facets = { mime: string; favorite: boolean; ratingMin: number | null };

function facetsKey(f: Facets): string {
  return `m=${f.mime}|f=${f.favorite ? 1 : 0}|r=${f.ratingMin ?? 0}`;
}

function buildAssetsUrl(f: Facets): string {
  const params = new URLSearchParams();
  if (f.mime) params.set("mime", f.mime);
  if (f.favorite) params.set("favorite", "1");
  if (f.ratingMin != null) params.set("ratingMin", String(f.ratingMin));
  const qs = params.toString();
  return qs ? `/api/v1/assets?${qs}` : "/api/v1/assets";
}

export default function TimelinePage() {
  const [mimeFilter, setMimeFilter] = useState("");
  const [favoriteFilter, setFavoriteFilter] = useState(false);
  const [ratingMinFilter, setRatingMinFilter] = useState<number | null>(null);
  const facets: Facets = useMemo(
    () => ({ mime: mimeFilter, favorite: favoriteFilter, ratingMin: ratingMinFilter }),
    [mimeFilter, favoriteFilter, ratingMinFilter]
  );
  const currentKey = facetsKey(facets);

  const [data, setData] = useState<{ assets: Asset[]; loading: boolean; filterKey: string }>({
    assets: [],
    loading: true,
    filterKey: "",
  });
  const assets = useMemo(
    () => (data.filterKey === currentKey ? data.assets : []),
    [data, currentKey]
  );
  const loading = data.filterKey === currentKey ? data.loading : true;
  const [lightboxAssets, setLightboxAssets] = useState<Asset[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = buildAssetsUrl(facets);
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const sorted = ((d.assets ?? []) as Asset[]).sort(
          (a, b) =>
            new Date(b.capturedAt ?? b.createdAt).getTime() -
            new Date(a.capturedAt ?? a.createdAt).getTime()
        );
        setData({ assets: sorted, loading: false, filterKey: currentKey });
      })
      .catch(() => {
        if (!cancelled) {
          setData({ assets: [], loading: false, filterKey: currentKey });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [facets, currentKey]);

  const setAssets = useCallback(
    (updater: (prev: Asset[]) => Asset[]) => {
      setData((prev) => ({ ...prev, assets: updater(prev.assets) }));
    },
    []
  );

  const openLightbox = useCallback(
    (asset: Asset) => {
      const images = assets.filter((a) => a.mimeType.startsWith("image/"));
      const index = images.findIndex((a) => a.id === asset.id);
      if (index !== -1) {
        setLightboxAssets(images);
        setLightboxIndex(index);
      }
    },
    [assets]
  );

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < lightboxAssets.length) setLightboxIndex(next);
  }

  function handleLightboxTrash(assetId: string) {
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
    setLightboxAssets((prev) => prev.filter((a) => a.id !== assetId));
    setLightboxIndex(null);
  }

  // Phase 3.4 — bubble favorite/rating mutations from the lightbox into
  // the timeline list so the grid badges (heart, star count) update without
  // a round-trip to the server.
  const handleAssetUpdate = useCallback(
    (assetId: string, patch: { isFavorite?: boolean; rating?: number }) => {
      const apply = (a: Asset): Asset => (a.id === assetId ? { ...a, ...patch } : a);
      setAssets((prev) => prev.map(apply));
      setLightboxAssets((prev) => prev.map(apply));
    },
    [setAssets]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Timeline</h1>
          <p className="text-sm text-muted-foreground mt-1">Chronological view of all assets</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["", "image/", "application/pdf", "text/"] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setMimeFilter(filter)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                mimeFilter === filter
                  ? "bg-foreground text-background border-foreground"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
              }`}
            >
              {filter === "" ? "All" : filter === "image/" ? "Photos" : filter === "application/pdf" ? "PDF" : "Text"}
            </button>
          ))}
          {/* Phase 3.4 — facet chips. Independent toggles; either or both
              can stack on top of the mime filter. */}
          <button
            onClick={() => setFavoriteFilter((v) => !v)}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              favoriteFilter
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
            aria-pressed={favoriteFilter}
          >
            <Heart
              className="h-3 w-3"
              fill={favoriteFilter ? "currentColor" : "none"}
            />
            Favorites
          </button>
          <button
            onClick={() => setRatingMinFilter((v) => (v === 4 ? null : 4))}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              ratingMinFilter === 4
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
            aria-pressed={ratingMinFilter === 4}
          >
            <Star
              className="h-3 w-3"
              fill={ratingMinFilter === 4 ? "currentColor" : "none"}
            />
            Rated 4+
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading timeline...
        </div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Clock className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No assets yet. Upload something from the Dashboard.</p>
        </div>
      ) : (
        <VirtualizedTimeline assets={assets} onAssetClick={openLightbox} />
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && lightboxAssets[lightboxIndex] && (
        <PhotoLightbox
          asset={lightboxAssets[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < lightboxAssets.length - 1}
          onTrash={handleLightboxTrash}
          onAssetUpdate={handleAssetUpdate}
        />
      )}
    </div>
  );
}
