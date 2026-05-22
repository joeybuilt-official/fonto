// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { VirtualizedTimeline } from "../_components/virtualized-timeline";

export default function TimelinePage() {
  const [mimeFilter, setMimeFilter] = useState("");
  const [data, setData] = useState<{ assets: Asset[]; loading: boolean; filter: string }>({
    assets: [],
    loading: true,
    filter: "",
  });
  const assets = useMemo(
    () => (data.filter === mimeFilter ? data.assets : []),
    [data, mimeFilter]
  );
  const loading = data.filter === mimeFilter ? data.loading : true;
  const [lightboxAssets, setLightboxAssets] = useState<Asset[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = mimeFilter
      ? `/api/v1/assets?mime=${encodeURIComponent(mimeFilter)}`
      : "/api/v1/assets";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const sorted = ((d.assets ?? []) as Asset[]).sort(
          (a, b) =>
            new Date(b.capturedAt ?? b.createdAt).getTime() -
            new Date(a.capturedAt ?? a.createdAt).getTime()
        );
        setData({ assets: sorted, loading: false, filter: mimeFilter });
      })
      .catch(() => {
        if (!cancelled) {
          setData({ assets: [], loading: false, filter: mimeFilter });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mimeFilter]);

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
        />
      )}
    </div>
  );
}
