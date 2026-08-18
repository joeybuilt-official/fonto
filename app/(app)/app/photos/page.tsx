// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useMemo, useState, useCallback, Suspense } from "react";
import { X, FolderPlus, Download, Trash2, Loader2 } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { ListErrorState } from "../_components/list-states";
import { AssetAskPanel } from "../_components/asset-ask-panel";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { useSnackbar } from "@/components/ui/snackbar";
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

  // Raw server feed (created-DESC keyset order). Client sort/search derive
  // `photos` from this; batch mutations splice it.
  const [rawPhotos, setRawPhotos] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const toast = useSnackbar();

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

  // Server-side query for the current filter set. `type` is the classification
  // subtype; `favorite` and `ratingMin` ride along server-side. Sort/search are
  // applied client-side over the loaded window (the list endpoint returns
  // created-DESC). The 200-row page is a KEYSET page, not the whole library —
  // load-more-on-scroll walks the rest via the opaque cursor.
  const buildQuery = useCallback(() => {
    const sp = new URLSearchParams();
    sp.set("mime", "image/");
    sp.set("limit", "200");
    if (toolbar.filters.type) sp.set("subtype", toolbar.filters.type);
    if (toolbar.filters.favorite) sp.set("favorite", "1");
    if (toolbar.filters.ratingMin != null) sp.set("ratingMin", String(toolbar.filters.ratingMin));
    return sp;
  }, [toolbar.filters.type, toolbar.filters.favorite, toolbar.filters.ratingMin]);

  // First page (and refetch on filter change / refreshKey). No abort/cancel:
  // filter changes are user-initiated and infrequent; last-wins is fine.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const r = await fetch(`/api/v1/assets?${buildQuery().toString()}`);
        if (!r.ok) throw new Error(`assets ${r.status}`);
        const d = (await r.json()) as { assets?: Asset[]; cursor?: string | null };
        if (cancelled) return;
        setRawPhotos(d.assets ?? []);
        setCursor(d.cursor ?? null);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildQuery, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = buildQuery();
      sp.set("cursor", cursor);
      const r = await fetch(`/api/v1/assets?${sp.toString()}`);
      if (r.ok) {
        const d = (await r.json()) as { assets?: Asset[]; cursor?: string | null };
        setRawPhotos((prev) => [...prev, ...(d.assets ?? [])]);
        setCursor(d.cursor ?? null);
      }
    } catch {
      /* transient — sentinel will retry on the next scroll tick */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildQuery]);

  // Client-side sort + text search over the loaded window.
  const photos = useMemo(() => {
    let list = rawPhotos;
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
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter(
        (a) =>
          a.filename.toLowerCase().includes(needle) ||
          (a.description?.toLowerCase().includes(needle) ?? false)
      );
    }
    return list;
  }, [rawPhotos, toolbar.filters.sort, toolbar.filters.q]);

  const openLightbox = useCallback((_id: string, index: number) => {
    setLightboxIndex(index);
  }, []);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < photos.length) setLightboxIndex(next);
  }

  async function handleBatchAddToCollection(collectionId: string) {
    const ids = Array.from(toolbar.selectedIds);
    const results = await Promise.allSettled(
      ids.map((assetId) =>
        fetch(`/api/v1/collections/${collectionId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId }),
        })
      )
    );
    const failedIds = ids.filter(
      (_id, i) =>
        results[i].status === "rejected" ||
        !(results[i] as PromiseFulfilledResult<Response>).value.ok
    );
    setShowCollectionModal(false);
    if (failedIds.length === 0) {
      toolbar.clearSelection();
      toast.add({ title: `Added ${ids.length} to collection` });
    } else {
      toolbar.clearSelection();
      for (const id of failedIds) toolbar.toggleSelect(id);
      toast.add({
        title: `Couldn't add ${failedIds.length} of ${ids.length}`,
        description: "Left selected — try again.",
        priority: "high",
      });
    }
  }

  function handleBatchDownload() {
    // M8 — one streamed zip instead of N separate browser downloads.
    downloadAssetsZip(Array.from(toolbar.selectedIds));
  }

  async function handleBatchTrash() {
    const ids = Array.from(toolbar.selectedIds);
    const results = await Promise.allSettled(
      ids.map((assetId) =>
        fetch(`/api/v1/assets/${assetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trash: true }),
        })
      )
    );
    const okIds = ids.filter(
      (_id, i) =>
        results[i].status === "fulfilled" &&
        (results[i] as PromiseFulfilledResult<Response>).value.ok
    );
    const failedIds = ids.filter((id) => !okIds.includes(id));
    // Only drop the ones that actually trashed.
    setRawPhotos((prev) => prev.filter((p) => !okIds.includes(p.id)));
    if (failedIds.length === 0) {
      toolbar.clearSelection();
      toast.add({ title: `Moved ${ids.length} to trash` });
    } else {
      toolbar.clearSelection();
      for (const id of failedIds) toolbar.toggleSelect(id);
      toast.add({
        title: `Couldn't trash ${failedIds.length} of ${ids.length}`,
        description: "Left selected — try again.",
        priority: "high",
      });
    }
  }

  function handleLightboxTrash(assetId: string) {
    setRawPhotos((prev) => prev.filter((p) => p.id !== assetId));
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
            onLoadMore={loadMore}
            hasMore={cursor !== null}
            loadingMore={loadingMore}
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
