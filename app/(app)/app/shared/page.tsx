// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7b — "Shared with me" workspace page.
//
// Lists assets shared INTO the active workspace from other workspaces.
// Each tile renders the standard PhotoCard with the "Shared from
// <workspace>" badge automatically (PhotoCard reads `asset.sharedFrom`).
// Clicking a tile opens the same PhotoLightbox as the photos grid —
// the URL endpoint already allows shared access via lib/assets/access.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Share2 } from "lucide-react";
import { PhotoCard, type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";

export default function SharedPage() {
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
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Share2 className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Shared with me</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
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
        />
      )}
    </div>
  );
}
