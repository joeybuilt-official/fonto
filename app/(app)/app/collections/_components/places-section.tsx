"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import type { PlaceGroup } from "@/app/api/v1/places/route";

interface PlaceWithUrls extends PlaceGroup {
  thumbUrls: string[];
}

export function PlacesSection() {
  const [places, setPlaces] = useState<PlaceWithUrls[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/places");
        const data = (await res.json()) as { places: PlaceGroup[] };
        if (!data.places?.length) { setLoading(false); return; }

        // Batch-fetch thumbnail URLs for all preview IDs.
        const allIds = data.places.flatMap((p) => p.previewIds);
        const urlsRes = await fetch("/api/v1/assets/urls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: allIds, variant: "thumb" }),
        });
        const urlsData = (await urlsRes.json()) as { urls?: Record<string, string> };
        const urlMap = urlsData.urls ?? {};

        setPlaces(
          data.places.map((p) => ({
            ...p,
            thumbUrls: p.previewIds.map((id) => urlMap[id]).filter(Boolean),
          }))
        );
      } catch {
        // silently degrade — section just won't render
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading || !places.length) return null;

  return (
    <section aria-labelledby="places-heading">
      <div className="mb-3 flex items-center gap-2">
        <MapPin className="size-4 text-muted-foreground" />
        <h2 id="places-heading" className="text-sm font-semibold text-foreground">
          Places
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {places.map((place) => (
          <PlaceCard key={place.placeName} place={place} />
        ))}
      </div>
    </section>
  );
}

function PlaceCard({ place }: { place: PlaceWithUrls }) {
  const href = `/app/library?place=${encodeURIComponent(place.placeName)}&kind=all`;
  const [city] = place.placeName.split(",");

  return (
    <Link
      href={href}
      aria-label={`${place.placeName}, ${place.count} photos`}
      className="group overflow-hidden rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all"
    >
      {/* 2×2 photo mosaic */}
      <div className="grid aspect-square grid-cols-2 grid-rows-2 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => {
          const url = place.thumbUrls[i];
          return url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div key={i} className="bg-muted" />
          );
        })}
      </div>
      <div className="p-2.5">
        <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
          {city?.trim() ?? place.placeName}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {place.count.toLocaleString()} {place.count === 1 ? "photo" : "photos"}
        </p>
      </div>
    </Link>
  );
}
