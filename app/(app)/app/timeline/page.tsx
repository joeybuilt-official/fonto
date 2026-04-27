"use client";

import { useEffect, useState, useCallback } from "react";
import { Clock, Loader2 } from "lucide-react";
import { PhotoCard, type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";

function groupByMonth(assets: Asset[]): [string, Asset[]][] {
  const map = new Map<string, Asset[]>();
  for (const a of assets) {
    const d = new Date(a.capturedAt ?? a.createdAt);
    // Key: YYYY-MM for sorting, label for display
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(a);
  }
  return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

function formatMonthLabel(key: string): string {
  const [year, month] = key.split("-");
  const d = new Date(parseInt(year), parseInt(month) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function TimelinePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [mimeFilter, setMimeFilter] = useState("");
  const [lightboxAssets, setLightboxAssets] = useState<Asset[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    const url = mimeFilter ? `/api/v1/assets?mime=${encodeURIComponent(mimeFilter)}` : "/api/v1/assets";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        const sorted = (d.assets ?? []).sort(
          (a: Asset, b: Asset) =>
            new Date(b.capturedAt ?? b.createdAt).getTime() -
            new Date(a.capturedAt ?? a.createdAt).getTime()
        );
        setAssets(sorted);
      })
      .finally(() => setLoading(false));
  }, [mimeFilter]);

  // Build a flat index for lightbox navigation (only image assets)
  const imageAssets = assets.filter((a) => a.mimeType.startsWith("image/"));

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

  const groups = groupByMonth(assets);

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
        <div className="space-y-8">
          {groups.map(([monthKey, group]) => {
            const imageGroup = group.filter((a) => a.mimeType.startsWith("image/"));
            return (
              <div key={monthKey}>
                {/* Sticky month header */}
                <div className="sticky top-0 z-10 -mx-4 md:-mx-6 mb-3 flex items-center gap-3 bg-background/90 backdrop-blur-sm px-4 md:px-6 py-2 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-widest text-foreground">
                    {formatMonthLabel(monthKey)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · {group.length} {group.length === 1 ? "asset" : "assets"}
                  </span>
                </div>

                {imageGroup.length > 0 ? (
                  <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                    {imageGroup.map((asset) => (
                      <PhotoCard
                        key={asset.id}
                        asset={asset}
                        showQuickActions
                        onClick={() => openLightbox(asset)}
                      />
                    ))}
                  </div>
                ) : (
                  // Non-image assets (PDFs, text, etc.) — show as list
                  <div className="space-y-1.5">
                    {group.map((asset) => (
                      <div
                        key={asset.id}
                        className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 hover:bg-muted/40 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{asset.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {asset.classification ?? asset.mimeType}
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(asset.capturedAt ?? asset.createdAt).toLocaleDateString(undefined, {
                            month: "short", day: "numeric",
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
