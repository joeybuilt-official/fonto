// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { X, FolderPlus, Download, Trash2, Loader2 } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { ListErrorState } from "../_components/list-states";
import { AssetAskPanel } from "../_components/asset-ask-panel";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { downloadAssetsZip } from "@/lib/download-zip";
import { Button } from "@/components/ui/button";

interface Collection {
  id: string;
  name: string;
}

function BatchActionBar({
  count: selectedCount,
  onAddToCollection,
  onDownload,
  onTrash,
  onClear,
}: {
  count: number;
  onAddToCollection: () => void;
  onDownload: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 flex items-center gap-2 rounded-[var(--ft-shape-large)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-high)]/95 backdrop-blur px-4 py-2.5 shadow-[var(--ft-elev-3)]">
      <span className="text-sm font-medium text-[var(--ft-color-on-surface)] mr-2">
        {selectedCount} {selectedCount === 1 ? "photo" : "photos"} selected
      </span>
      <Button
        variant="tonal"
        size="sm"
        onClick={onAddToCollection}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        Add to collection
      </Button>
      <Button
        variant="tonal"
        size="sm"
        onClick={onDownload}
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </Button>
      <Button
        variant="text"
        size="sm"
        onClick={onTrash}
        className="text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-error)_8%,transparent)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Move to trash
      </Button>
      <button
        onClick={onClear}
        className="rounded-[var(--ft-shape-full)] p-1.5 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
        title="Clear selection"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function AddToCollectionModal({
  collections,
  onSelect,
  onClose,
}: {
  collections: Collection[];
  onSelect: (collectionId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ft-color-scrim)]/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-80 rounded-[var(--ft-shape-large)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-high)] shadow-[var(--ft-elev-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--ft-color-on-surface)]">Add to Collection</p>
          <button onClick={onClose} className="text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {collections.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[var(--ft-color-on-surface-variant)]">No collections yet.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto py-1">
            {collections.map((col) => (
              <button
                key={col.id}
                onClick={() => onSelect(col.id)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
              >
                <FolderPlus className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
                {col.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PhotosContent() {
  // UX-3 — single toolbar state for search, sort, filter, density, view,
  // selection. URL stays the source of truth for filters; localStorage
  // remembers density. Replaces the hand-rolled useSearchParams +
  // useState(selectMode) + useRef(lastClickedIndex) wiring this page used
  // to carry.
  const toolbar = useToolbarState({
    page: "photos",
    // Only the filter slots that GET /api/v1/assets actually respects today
    // are exposed. Color / date range / personIds / tagIds will land when
    // the list endpoint adopts the same predicates as smart-collections.
    availableFilters: ["type", "favorite", "ratingMin"],
  });

  const [photos, setPhotos] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  useEffect(() => {
    fetch("/api/v1/collections")
      .then((r) => {
        if (!r.ok) throw new Error(`collections ${r.status}`);
        return r.json();
      })
      .then((d) => setCollections(d.collections ?? []))
      .catch(() => {
        // Non-fatal — the collections list only powers the add-to-collection
        // modal; leave it empty rather than blocking the page.
        setCollections([]);
      });
  }, []);

  // Fetch on every filter change. `type` is the classification subtype;
  // `favorite` and `ratingMin` ride along server-side. Sort is applied
  // client-side because the list endpoint always returns desc(created_at).
  // No abort/cancel: filter changes are user-initiated and infrequent;
  // race conditions resolve last-wins, which is the right semantic here.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(false);
      const sp = new URLSearchParams();
      sp.set("mime", "image/");
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
        }
        // Client-side text search across filename + description. The list
        // endpoint has no q= param; until it does, this keeps search useful.
        if (toolbar.filters.q) {
          const needle = toolbar.filters.q.toLowerCase();
          list = list.filter(
            (a) =>
              a.filename.toLowerCase().includes(needle) ||
              (a.description?.toLowerCase().includes(needle) ?? false)
          );
        }
        setPhotos(list);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [
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
    if (next >= 0 && next < photos.length) setLightboxIndex(next);
  }

  async function handleBatchAddToCollection(collectionId: string) {
    await Promise.all(
      Array.from(toolbar.selectedIds).map((assetId) =>
        fetch(`/api/v1/collections/${collectionId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId }),
        })
      )
    );
    setShowCollectionModal(false);
    toolbar.clearSelection();
  }

  function handleBatchDownload() {
    // M8 — one streamed zip instead of N separate browser downloads.
    downloadAssetsZip(Array.from(toolbar.selectedIds));
  }

  async function handleBatchTrash() {
    const ids = Array.from(toolbar.selectedIds);
    await Promise.all(
      ids.map((assetId) =>
        fetch(`/api/v1/assets/${assetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trash: true }),
        })
      )
    );
    setPhotos((prev) => prev.filter((p) => !toolbar.selectedIds.has(p.id)));
    toolbar.clearSelection();
  }

  function handleLightboxTrash(assetId: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== assetId));
    setLightboxIndex(null);
  }

  // Context for the Ask panel: selected ids if any, otherwise the full
  // visible result set. Capped at 200 — past that the prompt token cost
  // outweighs the marginal recall.
  function getAskContextIds(): string[] {
    if (toolbar.selectedIds.size > 0) {
      return Array.from(toolbar.selectedIds).slice(0, 200);
    }
    return photos.slice(0, 200).map((p) => p.id);
  }

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Photos"
        count={photos.length}
        toolbar={toolbar}
        searchPlaceholder="Search photos…"
        sortOptions={["newest", "oldest", "name", "rating"]}
        filterKeys={["type", "favorite", "ratingMin"]}
        showDensity
        showSelect
        onAskAI={() => setAskOpen(true)}
        getAskContextIds={getAskContextIds}
      />

      {error ? (
        <ListErrorState
          message="Couldn't load your photos. Check your connection and retry."
          onRetry={() => setRefreshKey((k) => k + 1)}
        />
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading photos...
        </div>
      ) : (
        <div className="px-4">
          <AssetGrid
            assets={photos}
            toolbar={toolbar}
            viewMode="grid"
            onAssetClick={openLightbox}
            onAddToCollection={(assetId) => {
              toolbar.setSelectMode(true);
              // Stage the single asset as the selection so the modal handler
              // works for both per-card and batch invocations.
              toolbar.clearSelection();
              toolbar.toggleSelect(assetId);
              setShowCollectionModal(true);
            }}
          />
        </div>
      )}

      {lightboxIndex !== null && (
        <PhotoLightbox
          asset={photos[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < photos.length - 1}
          prevAssetId={lightboxIndex > 0 ? photos[lightboxIndex - 1]?.id ?? null : null}
          nextAssetId={
            lightboxIndex < photos.length - 1 ? photos[lightboxIndex + 1]?.id ?? null : null
          }
          onTrash={handleLightboxTrash}
        />
      )}

      <BatchActionBar
        count={toolbar.selectedIds.size}
        onAddToCollection={() => setShowCollectionModal(true)}
        onDownload={handleBatchDownload}
        onTrash={handleBatchTrash}
        onClear={() => toolbar.clearSelection()}
      />

      {showCollectionModal && (
        <AddToCollectionModal
          collections={collections}
          onSelect={handleBatchAddToCollection}
          onClose={() => setShowCollectionModal(false)}
        />
      )}

      <AssetAskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        contextAssetIds={getAskContextIds()}
        contextLabel={`${photos.length} photo${photos.length === 1 ? "" : "s"}`}
      />
    </div>
  );
}

export default function PhotosPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading...</div>}>
      <PhotosContent />
    </Suspense>
  );
}
