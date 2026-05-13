// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Image as ImageIcon, MousePointer2, X, FolderPlus, Download, Trash2, CheckSquare, Loader2 } from "lucide-react";
import { Suspense } from "react";
import { PhotoCard, type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";

const IMAGE_SUBTYPES = ["photo", "screenshot", "mockup", "logo", "icon"] as const;
const SUBTYPE_LABELS: Record<string, string> = {
  photo: "Photos",
  screenshot: "Screenshots",
  mockup: "Mockups",
  logo: "Logos",
  icon: "Icons",
};

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
] as const;

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
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 flex items-center gap-2 rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-2.5 shadow-xl">
      <span className="text-sm font-medium text-foreground mr-2">
        {selectedCount} {selectedCount === 1 ? "photo" : "photos"} selected
      </span>
      <button
        onClick={onAddToCollection}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/10 hover:text-primary transition-colors"
      >
        <FolderPlus className="h-3.5 w-3.5" />
        Add to collection
      </button>
      <button
        onClick={onDownload}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
      <button
        onClick={onTrash}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Move to trash
      </button>
      <button
        onClick={onClear}
        className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-80 rounded-xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Add to Collection</p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {collections.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No collections yet.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto py-1">
            {collections.map((col) => (
              <button
                key={col.id}
                onClick={() => onSelect(col.id)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <FolderPlus className="h-4 w-4 text-muted-foreground" />
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type") ?? "";
  const sortParam = (searchParams.get("sort") ?? "newest") as "newest" | "oldest";

  const [photos, setPhotos] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const lastClickedIndex = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/v1/collections")
      .then((r) => r.json())
      .then((d) => setCollections(d.collections ?? []));
  }, []);

  useEffect(() => {
    setLoading(true);
    const url = typeParam
      ? `/api/v1/assets?mime=image/&subtype=${typeParam}`
      : "/api/v1/assets?mime=image/";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        let list = (d.assets ?? []) as Asset[];
        if (sortParam === "oldest") {
          list = [...list].sort(
            (a, b) =>
              new Date(a.capturedAt ?? a.createdAt).getTime() -
              new Date(b.capturedAt ?? b.createdAt).getTime()
          );
        }
        setPhotos(list);
      })
      .finally(() => setLoading(false));
  }, [typeParam, sortParam]);

  function setFilter(type: string | null, sort?: string) {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (sort ?? sortParam) params.set("sort", sort ?? sortParam);
    router.replace(`/app/photos?${params.toString()}`);
  }

  function setSort(sort: string) {
    const params = new URLSearchParams();
    if (typeParam) params.set("type", typeParam);
    params.set("sort", sort);
    router.replace(`/app/photos?${params.toString()}`);
  }

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < photos.length) setLightboxIndex(next);
  }

  function handleCardClick(index: number, e: React.MouseEvent) {
    if (selectMode) {
      if (e.shiftKey && lastClickedIndex.current !== null) {
        // Range select
        const from = Math.min(lastClickedIndex.current, index);
        const to = Math.max(lastClickedIndex.current, index);
        setSelected((prev) => {
          const next = new Set(prev);
          for (let i = from; i <= to; i++) next.add(photos[i].id);
          return next;
        });
      } else {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(photos[index].id)) next.delete(photos[index].id);
          else next.add(photos[index].id);
          return next;
        });
      }
      lastClickedIndex.current = index;
    } else {
      openLightbox(index);
    }
  }

  function handleToggleSelectMode() {
    setSelectMode((v) => !v);
    setSelected(new Set());
  }

  async function handleBatchAddToCollection(collectionId: string) {
    await Promise.all(
      Array.from(selected).map((assetId) =>
        fetch(`/api/v1/collections/${collectionId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId }),
        })
      )
    );
    setShowCollectionModal(false);
    setSelected(new Set());
  }

  async function handleBatchDownload() {
    // Download each selected photo individually
    for (const assetId of selected) {
      const asset = photos.find((p) => p.id === assetId);
      if (!asset) continue;
      const res = await fetch(`/api/v1/assets/${assetId}/url`);
      if (res.ok) {
        const d = await res.json();
        if (d.url) {
          const a = document.createElement("a");
          a.href = d.url;
          a.download = asset.filename;
          a.click();
          // small delay to avoid browser blocking multiple downloads
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }

  async function handleBatchTrash() {
    await Promise.all(
      Array.from(selected).map((assetId) =>
        fetch(`/api/v1/assets/${assetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trash: true }),
        })
      )
    );
    setPhotos((prev) => prev.filter((p) => !selected.has(p.id)));
    setSelected(new Set());
  }

  function handleLightboxTrash(assetId: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== assetId));
    setLightboxIndex(null);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Photos</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {photos.length} image{photos.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={handleToggleSelectMode}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            selectMode
              ? "bg-primary text-primary-foreground"
              : "border border-border text-muted-foreground hover:text-foreground hover:border-foreground"
          }`}
        >
          {selectMode ? (
            <>
              <X className="h-3.5 w-3.5" />
              Cancel
            </>
          ) : (
            <>
              <CheckSquare className="h-3.5 w-3.5" />
              Select
            </>
          )}
        </button>
      </div>

      {/* Filter bar */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setFilter(null)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              !typeParam
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          {IMAGE_SUBTYPES.map((subtype) => (
            <button
              key={subtype}
              onClick={() => setFilter(typeParam === subtype ? null : subtype)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                typeParam === subtype
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {SUBTYPE_LABELS[subtype]}
            </button>
          ))}
          <div className="ml-auto">
            <select
              value={sortParam}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading photos...
        </div>
      ) : photos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No photos yet. Upload images from the Dashboard.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {photos.map((photo, index) => (
            <div key={photo.id} onClick={(e) => handleCardClick(index, e)}>
              <PhotoCard
                asset={photo}
                selected={selected.has(photo.id)}
                onSelect={() => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(photo.id)) next.delete(photo.id);
                    else next.add(photo.id);
                    return next;
                  });
                }}
                selectMode={selectMode}
                showQuickActions={!selectMode}
                onAddToCollection={(assetId) => {
                  setSelected(new Set([assetId]));
                  setShowCollectionModal(true);
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <PhotoLightbox
          asset={photos[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < photos.length - 1}
          onTrash={handleLightboxTrash}
        />
      )}

      {/* Batch action bar */}
      <BatchActionBar
        count={selected.size}
        onAddToCollection={() => setShowCollectionModal(true)}
        onDownload={handleBatchDownload}
        onTrash={handleBatchTrash}
        onClear={() => setSelected(new Set())}
      />

      {/* Add to collection modal */}
      {showCollectionModal && (
        <AddToCollectionModal
          collections={collections}
          onSelect={handleBatchAddToCollection}
          onClose={() => setShowCollectionModal(false)}
        />
      )}
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
