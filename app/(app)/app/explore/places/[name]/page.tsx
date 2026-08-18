// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Explore → Places → place detail. Lists every photo whose reverse-geocoded
// place_name matches the route segment, via GET /api/v1/assets?place=<name>.
// Mirrors the folder view's toolbar + AssetGrid + lightbox wiring.
"use client";

import { Suspense, use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, MapPin } from "lucide-react";
import { type Asset } from "../../../_components/photo-card";
import { PhotoLightbox } from "../../../_components/photo-lightbox";
import { AssetPageToolbar } from "../../../_components/asset-page-toolbar";
import { AssetGrid } from "../../../_components/asset-grid";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

function PlaceDetailContent({ name }: { name: string }) {
  const toolbar = useToolbarState({
    page: "places-detail",
    availableFilters: ["mime", "type", "favorite", "ratingMin"],
  });

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset load state on filter change before refetch
    setLoading(true);
    setError(null);
    const url = new URL("/api/v1/assets", window.location.origin);
    url.searchParams.set("place", name);
    if (toolbar.filters.mime) url.searchParams.set("mime", toolbar.filters.mime);
    if (toolbar.filters.type) url.searchParams.set("subtype", toolbar.filters.type);
    if (toolbar.filters.favorite) url.searchParams.set("favorite", "1");
    if (toolbar.filters.ratingMin != null)
      url.searchParams.set("ratingMin", String(toolbar.filters.ratingMin));

    fetch(url.toString())
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        let list = ((d.assets ?? []) as Asset[]);
        if (toolbar.filters.q) {
          const needle = toolbar.filters.q.toLowerCase();
          list = list.filter(
            (a) =>
              a.filename.toLowerCase().includes(needle) ||
              (a.description?.toLowerCase().includes(needle) ?? false)
          );
        }
        if (toolbar.filters.sort === "oldest") {
          list = [...list].sort(
            (a, b) =>
              new Date(a.capturedAt ?? a.createdAt).getTime() -
              new Date(b.capturedAt ?? b.createdAt).getTime()
          );
        } else if (toolbar.filters.sort === "name") {
          list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
        }
        setAssets(list);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load photos for this place.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    name,
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.q,
    toolbar.filters.sort,
  ]);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  return (
    <div className="space-y-3">
      <div className="px-4 pt-2">
        <Link
          href="/app/explore/places"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Places
        </Link>
      </div>

      <AssetPageToolbar
        title={name}
        count={loading ? undefined : assets.length}
        toolbar={toolbar}
        searchPlaceholder="Search this place…"
        sortOptions={["newest", "oldest", "name"]}
        filterKeys={["mime", "type", "favorite", "ratingMin"]}
        showDensity
        showSelect
      />

      <div className="px-4 space-y-4">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading photos…
          </div>
        )}

        {error && !loading && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && assets.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <MapPin className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No photos for this place.
            </p>
          </div>
        )}

        {!loading && assets.length > 0 && (
          <AssetGrid
            assets={assets}
            toolbar={toolbar}
            viewMode="grid"
            onAssetClick={(_id, index) => setLightboxIndex(index)}
          />
        )}
      </div>

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <PhotoLightbox
          asset={assets[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
          prevAssetId={lightboxIndex > 0 ? assets[lightboxIndex - 1]?.id ?? null : null}
          nextAssetId={
            lightboxIndex < assets.length - 1 ? assets[lightboxIndex + 1]?.id ?? null : null
          }
        />
      )}
    </div>
  );
}

export default function PlaceDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = use(params);
  const decoded = decodeURIComponent(name);
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <PlaceDetailContent name={decoded} />
    </Suspense>
  );
}
