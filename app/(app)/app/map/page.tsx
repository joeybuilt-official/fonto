// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.2 — interactive map of geo-tagged assets.
//
// Stack:
//   - MapLibre GL JS (vector renderer, open-source MapBox fork) for the map.
//   - OSM raster tiles (https://tile.openstreetmap.org/{z}/{x}/{y}.png). The
//     attribution footer is mandatory per OSM tile usage policy.
//   - Supercluster (Mapbox) for client-side hierarchical clustering. We pass
//     it the full result set returned by /assets/within-bbox and re-query
//     per (bbox, zoom) on every debounced viewport change.
//
// MapLibre + supercluster aren't loaded statically — we use dynamic `import()`
// from inside a `useEffect` so the SSR pass (Next.js) and the test harness
// don't try to evaluate WebGL-only code in Node. The deps are still listed
// in package.json so `pnpm install` materialises the right versions.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { PhotoLightbox } from "../_components/photo-lightbox";
import type { Asset } from "../_components/photo-card";

const TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

// Default viewport — Reykjavík-centred, world-scale. The user's last centre
// would be nicer; defer that to localStorage hydration in a follow-up.
const DEFAULT_CENTRE: [number, number] = [-21.89541, 64.13548];
const DEFAULT_ZOOM = 2;

// Debounce window for bbox refetches. Long enough that a continuous pan
// doesn't flood the server; short enough that a momentum-flick still
// updates within ~one frame after motion stops.
const REFETCH_DEBOUNCE_MS = 350;

const MAX_LIMIT = 5000;

interface MapAsset {
  id: string;
  latitude: number;
  longitude: number;
  thumbnailUrl: string | null;
  capturedAt: string | null;
  placeName: string | null;
}

interface ClusterFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties:
    | { cluster: true; cluster_id: number; point_count: number }
    | { cluster: false; assetId: string; placeName: string | null; thumbnailUrl: string | null };
}

interface SuperclusterInstance {
  load: (points: ClusterFeature[]) => void;
  getClusters: (bbox: [number, number, number, number], zoom: number) => ClusterFeature[];
  getClusterExpansionZoom: (clusterId: number) => number;
}

interface MapLikeInstance {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  getBounds(): {
    getWest(): number;
    getEast(): number;
    getNorth(): number;
    getSouth(): number;
  };
  getZoom(): number;
  flyTo(opts: { center: [number, number]; zoom: number }): void;
  remove(): void;
}

export default function MapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLikeInstance | null>(null);
  const markersRef = useRef<Array<{ remove: () => void }>>([]);
  const clusterRef = useRef<SuperclusterInstance | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // We hand maplibre's `maplibregl` namespace into the popup/marker render so
  // it stays in the same SDK version the map instance was created from.
  const maplibreNsRef = useRef<unknown>(null);

  const [assets, setAssets] = useState<MapAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lightbox state: index into the in-bbox `assets` so prev/next nav walks
  // the same set the user is looking at on the map.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const fetchBbox = useCallback(async (bounds: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        minLat: String(bounds.minLat),
        maxLat: String(bounds.maxLat),
        minLon: String(bounds.minLon),
        maxLon: String(bounds.maxLon),
        limit: String(MAX_LIMIT),
      });
      const res = await fetch(`/api/v1/assets/within-bbox?${params}`);
      if (!res.ok) {
        setError(`Failed to load (${res.status}).`);
        setAssets([]);
        return;
      }
      const data = (await res.json()) as { assets: MapAsset[] };
      const next = data.assets ?? [];
      setAssets(next);
      setCapped(next.length >= MAX_LIMIT);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initialise the map once. Dynamic import avoids breaking SSR (MapLibre
  // imports `window` at module evaluation time).
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      const [maplibreMod, superclusterMod] = await Promise.all([
        import("maplibre-gl"),
        import("supercluster"),
      ]);
      if (cancelled) return;

      // The MapLibre stylesheet is required for the controls + popup chrome.
      // Loaded once per session; subsequent imports are no-ops.
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (cancelled) return;

      const maplibregl = (maplibreMod as unknown as { default: unknown }).default
        ?? maplibreMod;
      maplibreNsRef.current = maplibregl;
      const MapCtor = (maplibregl as { Map: new (opts: unknown) => MapLikeInstance }).Map;
      const SuperclusterCtor = (superclusterMod as unknown as {
        default: new (opts: unknown) => SuperclusterInstance;
      }).default;

      // Raster-only style — keeps the dep surface tiny. If we ever want
      // dark mode tiles, swap source.tiles for a CartoDB / Stadia URL set.
      const style = {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [TILE_URL_TEMPLATE],
            tileSize: 256,
            attribution: TILE_ATTRIBUTION,
          },
        },
        layers: [
          {
            id: "osm-tiles",
            type: "raster",
            source: "osm",
            minzoom: 0,
            maxzoom: 19,
          },
        ],
      };

      const map = new MapCtor({
        container,
        style,
        center: DEFAULT_CENTRE,
        zoom: DEFAULT_ZOOM,
      });
      mapRef.current = map;

      clusterRef.current = new SuperclusterCtor({
        radius: 60,
        maxZoom: 18,
        minPoints: 2,
      });

      const triggerRefetch = () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          const b = map.getBounds();
          fetchBbox({
            minLat: b.getSouth(),
            maxLat: b.getNorth(),
            minLon: b.getWest(),
            maxLon: b.getEast(),
          });
        }, REFETCH_DEBOUNCE_MS);
      };

      map.on("moveend", triggerRefetch);
      map.on("zoomend", triggerRefetch);
      map.on("load", triggerRefetch);
    })().catch((err) => {
      console.error("[fonto-map] init failed:", err);
      setError("Failed to load map.");
    });

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [fetchBbox]);

  // Re-render markers whenever the asset set changes. We always rebuild from
  // scratch — supercluster is fast and re-attaching 5k markers is cheaper
  // than diffing two large sets.
  useEffect(() => {
    const map = mapRef.current;
    const sc = clusterRef.current;
    interface MarkerInstance {
      setLngLat: (xy: [number, number]) => MarkerInstance;
      addTo: (m: unknown) => { remove: () => void };
    }
    const maplibregl = maplibreNsRef.current as
      | { Marker: new (opts?: unknown) => MarkerInstance }
      | null;
    if (!map || !sc || !maplibregl) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    const points: ClusterFeature[] = assets.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.longitude, a.latitude] },
      properties: {
        cluster: false,
        assetId: a.id,
        placeName: a.placeName,
        thumbnailUrl: a.thumbnailUrl,
      },
    }));
    sc.load(points);

    const bounds = map.getBounds();
    const zoom = Math.round(map.getZoom());
    const clusters = sc.getClusters(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      zoom
    );

    for (const c of clusters) {
      const [lon, lat] = c.geometry.coordinates;
      const el = document.createElement("div");
      if (c.properties.cluster) {
        const count = c.properties.point_count;
        const clusterId = c.properties.cluster_id;
        el.className =
          "flex items-center justify-center rounded-full bg-[var(--ft-color-primary)] text-[var(--ft-color-on-primary)] text-xs font-semibold shadow-[var(--ft-elev-2)] cursor-pointer ring-2 ring-[var(--ft-color-surface)]";
        const size = 28 + Math.min(count, 100) * 0.35;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.textContent = String(count);
        el.addEventListener("click", () => {
          const expandZoom = sc.getClusterExpansionZoom(clusterId);
          map.flyTo({ center: [lon, lat], zoom: expandZoom });
        });
      } else {
        const p = c.properties;
        el.className =
          "h-10 w-10 overflow-hidden rounded-full ring-2 ring-[var(--ft-color-surface)] shadow-[var(--ft-elev-2)] cursor-pointer bg-[var(--ft-color-surface-container)]";
        if (p.thumbnailUrl) {
          const img = document.createElement("img");
          img.src = p.thumbnailUrl;
          img.alt = p.placeName ?? "asset";
          img.className = "h-full w-full object-cover";
          img.loading = "lazy";
          el.appendChild(img);
        }
        el.title = p.placeName ?? "";
        el.addEventListener("click", () => {
          const idx = assets.findIndex((a) => a.id === p.assetId);
          if (idx >= 0) setLightboxIndex(idx);
        });
      }
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([lon, lat])
        .addTo(map as unknown as object);
      markersRef.current.push(marker);
    }
  }, [assets]);

  // Hydrate the lightbox-ready Asset shape from a MapAsset. Most fields are
  // unknown to the bbox query (description, classification, etc.) but the
  // lightbox tolerates nulls / undefined for those.
  // Audit bug §UX-4 fix: never show the asset UUID as the filename.
  // Falls back to placeName, then a capturedAt date stamp, then "Photo".
  const lightboxAsset: Asset | null =
    lightboxIndex != null && assets[lightboxIndex]
      ? (() => {
          const m = assets[lightboxIndex];
          const filename =
            m.placeName ??
            (m.capturedAt
              ? `Photo · ${new Date(m.capturedAt).toLocaleDateString()}`
              : "Photo");
          return {
            id: m.id,
            filename,
            mimeType: "image/*",
            sizeBytes: 0,
            description: null,
            classification: null,
            processingState: "ready",
            capturedAt: m.capturedAt,
            createdAt: m.capturedAt ?? new Date().toISOString(),
          };
        })()
      : null;

  return (
    <div className="flex h-full flex-col">
      {/* Full-bleed map with floating title + stats chip overlay (audit §3).
          The old header was a 60px+ block that competed with the map for
          screen real estate even though it carried no interactive content
          beyond the title. The chip stays out of the way and updates in
          place as the viewport changes. */}
      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface)]/85 px-3 py-1.5 text-sm shadow-[var(--ft-elev-2)] backdrop-blur">
          <h1 className="font-heading text-base font-semibold text-[var(--ft-color-on-surface)]">Map</h1>
          <span className="text-xs text-[var(--ft-color-on-surface-variant)]">·</span>
          {loading && <span className="text-xs text-[var(--ft-color-on-surface-variant)]">Loading…</span>}
          {!loading && capped && (
            <span className="text-xs text-[var(--ft-color-on-surface-variant)]">
              {MAX_LIMIT.toLocaleString()} max — zoom in for more
            </span>
          )}
          {!loading && !capped && assets.length > 0 && (
            <span className="text-xs tabular-nums text-[var(--ft-color-on-surface-variant)]">
              {assets.length.toLocaleString()} in view
            </span>
          )}
          {!loading && assets.length === 0 && !error && (
            <span className="text-xs text-[var(--ft-color-on-surface-variant)]">No geo-tagged photos here</span>
          )}
          {error && <span className="text-xs text-[var(--ft-color-error)]">{error}</span>}
        </div>

        {assets.length === 0 && !loading && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface)]/80 px-3 py-2 text-sm text-[var(--ft-color-on-surface-variant)] shadow-[var(--ft-elev-1)]">
              <ImageIcon className="h-4 w-4" />
              No geo-tagged photos in this view yet.
            </div>
          </div>
        )}
      </div>

      {/* OSM attribution — required by the tile usage policy. MapLibre also
          renders an in-canvas attribution control, but a static footer is the
          policy-compliant fallback for screenshots / PDFs. */}
      <div
        className="border-t border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)]/40 px-4 py-2 text-[11px] text-[var(--ft-color-on-surface-variant)]"
        dangerouslySetInnerHTML={{ __html: `Map data ${TILE_ATTRIBUTION}` }}
      />

      {lightboxAsset != null && lightboxIndex != null && (
        <PhotoLightbox
          asset={lightboxAsset}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => {
            if (lightboxIndex > 0) setLightboxIndex(lightboxIndex - 1);
          }}
          onNext={() => {
            if (lightboxIndex < assets.length - 1) setLightboxIndex(lightboxIndex + 1);
          }}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
        />
      )}
    </div>
  );
}
