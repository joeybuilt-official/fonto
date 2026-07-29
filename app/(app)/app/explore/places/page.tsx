// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Explore → Places directory grid. Groups geo-tagged assets by
// reverse-geocoded place name (GET /api/v1/assets/places). Each card drills
// into /app/explore/places/[name], which lists that place's photos. Mirrors
// the People grid so the Explore surfaces stay consistent.
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";

interface PlaceEntry {
  name: string;
  count: number;
  coverAssetId: string | null;
  lat: number | null;
  lng: number | null;
}

const MAP_ZOOM = 10;

// Web-Mercator lat/lng → OSM raster tile (z/x/y). A single tile renders the
// area around the place; keyless via the public OSM tile server. Swap in a
// static-map provider (Mapbox/Google) here if higher fidelity is wanted.
function tileUrl(lat: number, lng: number, z: number): string {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function PlaceCover({ entry }: { entry: PlaceEntry }) {
  if (entry.lat == null || entry.lng == null) {
    return (
      <div className="aspect-square rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container)] flex items-center justify-center">
        <MapPin className="h-8 w-8 text-[var(--ft-color-on-surface-variant)]" />
      </div>
    );
  }
  return (
    <div
      className="relative aspect-square rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container)] overflow-hidden bg-cover bg-center"
      style={{ backgroundImage: `url(${tileUrl(entry.lat, entry.lng, MAP_ZOOM)})` }}
      role="img"
      aria-label={`Map of ${entry.name}`}
    >
      <MapPin className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-full text-[var(--ft-color-error)] drop-shadow" />
    </div>
  );
}

function PlacesContent() {
  const [places, setPlaces] = useState<PlaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/assets/places");
      if (!res.ok) {
        setError(`Failed to load places (${res.status}).`);
        setPlaces([]);
        return;
      }
      const data = (await res.json()) as { places: PlaceEntry[] };
      setPlaces(data.places ?? []);
    } catch {
      setError("Network error loading places.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-4 pt-2">
        <h1 className="text-lg font-semibold text-foreground">Places</h1>
        {!loading && (
          <span className="text-sm text-muted-foreground">
            {places.length} {places.length === 1 ? "place" : "places"}
          </span>
        )}
      </div>

      <div className="px-4 space-y-4">
        {loading && (
          <p className="text-sm text-muted-foreground">Loading places…</p>
        )}

        {error && !loading && (
          <p className="text-sm text-[var(--ft-color-error)]">{error}</p>
        )}

        {!loading && !error && places.length === 0 && (
          <div className="rounded-[var(--ft-shape-medium)] border border-dashed border-[var(--ft-color-outline-variant)] p-8 text-center">
            <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
              No places yet. Import photos taken with location data and
              they&rsquo;ll group here by where they were shot.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {places.map((p) => (
            <Link
              key={p.name}
              href={`/app/explore/places/${encodeURIComponent(p.name)}`}
              className="group block space-y-2"
            >
              <PlaceCover entry={p} />
              <div className="px-1">
                <div className="truncate text-sm font-medium text-[var(--ft-color-on-surface)] group-hover:underline">
                  {p.name}
                </div>
                <div className="text-xs text-[var(--ft-color-on-surface-variant)]">
                  {p.count} {p.count === 1 ? "photo" : "photos"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PlacesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <PlacesContent />
    </Suspense>
  );
}
