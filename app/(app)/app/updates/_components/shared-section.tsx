// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — Shared-with-me section of the Updates
// surface.
//
// Lifts the body of the legacy `/app/shared` page into a section
// component. Network endpoint + state shape are unchanged.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PhotoCard, type Asset } from "../../_components/photo-card";
import { PhotoLightbox } from "../../_components/photo-lightbox";

export function SharedSection() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/workspace/shared-with-me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { assets: Asset[] };
      setAssets(data.assets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAsset = openIndex !== null ? assets[openIndex] : null;

  return (
    <section aria-labelledby="updates-shared-heading" className="space-y-3">
      <h2
        id="updates-shared-heading"
        className="text-base font-semibold text-foreground"
      >
        Shared with me
      </h2>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          Nothing shared with you yet. When another workspace shares an asset
          into this one, it shows up here.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {assets.map((asset, i) => (
            <PhotoCard
              key={asset.id}
              asset={asset}
              onClick={() => setOpenIndex(i)}
            />
          ))}
        </div>
      )}

      {openAsset && (
        <PhotoLightbox
          asset={openAsset}
          onClose={() => setOpenIndex(null)}
          onPrev={() =>
            setOpenIndex((idx) =>
              idx === null ? null : idx > 0 ? idx - 1 : idx
            )
          }
          onNext={() =>
            setOpenIndex((idx) =>
              idx === null ? null : idx < assets.length - 1 ? idx + 1 : idx
            )
          }
          hasPrev={openIndex !== null && openIndex > 0}
          hasNext={openIndex !== null && openIndex < assets.length - 1}
          prevAssetId={
            openIndex !== null && openIndex > 0
              ? assets[openIndex - 1]?.id ?? null
              : null
          }
          nextAssetId={
            openIndex !== null && openIndex < assets.length - 1
              ? assets[openIndex + 1]?.id ?? null
              : null
          }
        />
      )}
    </section>
  );
}
