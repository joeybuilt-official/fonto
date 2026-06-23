// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useCallback } from "react";
import { use } from "react";
import Link from "next/link";
import {
  ChevronLeft, FolderOpen, Plus, X, Image as ImageIcon,
  Loader2, Check, Download
} from "lucide-react";
import { PhotoCard, type Asset } from "../../_components/photo-card";
import { PhotoLightbox } from "../../_components/photo-lightbox";
import { ListErrorState } from "../../_components/list-states";
import { downloadCollectionZip } from "@/lib/download-zip";

interface CollectionDetail {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  assetCount: number;
}

function AddPhotosModal({
  collectionId,
  existingIds,
  onClose,
  onAdded,
}: {
  collectionId: string;
  existingIds: Set<string>;
  onClose: () => void;
  onAdded: (assets: Asset[]) => void;
}) {
  const [allPhotos, setAllPhotos] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/v1/assets?mime=image/")
      .then((r) => r.json())
      .then((d) => {
        const photos = (d.assets ?? []) as Asset[];
        // Filter out already-in-collection
        setAllPhotos(photos.filter((p) => !existingIds.has(p.id)));
      })
      .finally(() => setLoading(false));
  }, [existingIds]);

  useEffect(() => {
    // Lazy-load URLs for visible photos
    allPhotos.slice(0, 24).forEach((photo) => {
      if (!photoUrls[photo.id]) {
        fetch(`/api/v1/assets/${photo.id}/url`)
          .then((r) => r.json())
          .then((d) => {
            if (d.url) setPhotoUrls((prev) => ({ ...prev, [photo.id]: d.url }));
          });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPhotos]);

  async function handleAdd() {
    setAdding(true);
    setAddError(null);
    const added: Asset[] = [];
    let failed = 0;
    for (const assetId of selected) {
      try {
        const res = await fetch(`/api/v1/collections/${collectionId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId }),
        });
        if (res.ok) {
          const asset = allPhotos.find((p) => p.id === assetId);
          if (asset) added.push(asset);
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    if (added.length > 0) onAdded(added);
    setAdding(false);
    if (failed > 0) {
      // Keep the modal open and report the partial failure so the user can
      // retry the ones that didn't land (the successes were already removed
      // from the candidate list via onAdded → existingIds).
      setSelected(new Set());
      setAddError(`Couldn't add ${failed} photo${failed === 1 ? "" : "s"}. Try again.`);
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-border bg-card shadow-xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
          <p className="text-sm font-semibold text-foreground">
            Add Photos
            {selected.size > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({selected.size} selected)
              </span>
            )}
          </p>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : allPhotos.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              All photos are already in this collection.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5">
              {allPhotos.map((photo) => {
                const isSelected = selected.has(photo.id);
                return (
                  <div
                    key={photo.id}
                    onClick={() => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(photo.id)) next.delete(photo.id);
                        else next.add(photo.id);
                        return next;
                      });
                    }}
                    className={`relative aspect-square cursor-pointer overflow-hidden rounded-lg transition-all ${
                      isSelected ? "ring-2 ring-primary ring-offset-1" : ""
                    }`}
                  >
                    <div className="h-full w-full bg-muted/30 flex items-center justify-center overflow-hidden">
                      {photoUrls[photo.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photoUrls[photo.id]}
                          alt={photo.filename}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <ImageIcon className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
                    {isSelected && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                        <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                          <Check className="h-3.5 w-3.5 text-white" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {addError && (
          <p className="border-t border-border px-4 py-2 text-sm text-destructive shrink-0">
            {addError}
          </p>
        )}

        {selected.size > 0 && (
          <div className="border-t border-border px-4 py-3 shrink-0 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={adding}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {adding && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Add {selected.size} {selected.size === 1 ? "photo" : "photos"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CollectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: collectionId } = use(params);

  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    Promise.all([
      fetch(`/api/v1/collections/${collectionId}`).then((r) => {
        if (!r.ok) throw new Error(`collection ${r.status}`);
        return r.json();
      }),
      fetch(`/api/v1/collections/${collectionId}/assets`).then((r) => {
        if (!r.ok) throw new Error(`collection assets ${r.status}`);
        return r.json();
      }),
    ])
      .then(([colData, assetsData]) => {
        setCollection(colData.collection ?? null);
        setAssets(assetsData.assets ?? []);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [collectionId, refreshKey]);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  async function handleRemove(assetId: string) {
    await fetch(`/api/v1/collections/${collectionId}/assets?assetId=${assetId}`, {
      method: "DELETE",
    });
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
  }

  function handleAdded(newAssets: Asset[]) {
    setAssets((prev) => [...prev, ...newAssets]);
  }

  function handleLightboxTrash(assetId: string) {
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
    setLightboxIndex(null);
  }

  const existingIds = new Set(assets.map((a) => a.id));

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading collection...
      </div>
    );
  }

  if (error) {
    return (
      <ListErrorState
        message="Couldn't load this collection. Check your connection and retry."
        onRetry={() => setRefreshKey((k) => k + 1)}
      />
    );
  }

  if (!collection) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-muted-foreground">Collection not found.</p>
        <Link href="/app/collections" className="mt-2 inline-block text-sm text-primary-text hover:underline">
          Back to Collections
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Breadcrumb + back */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link href="/app/collections" className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ChevronLeft className="h-3.5 w-3.5" />
          Collections
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">{collection.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <FolderOpen className="h-5 w-5 text-primary-text" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{collection.name}</h1>
            <p className="text-sm text-muted-foreground">
              {assets.length} {assets.length === 1 ? "photo" : "photos"}
              {collection.description && ` · ${collection.description}`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {assets.length > 0 && (
            <button
              onClick={() => downloadCollectionZip(collectionId)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              title="Download all as zip"
            >
              <Download className="h-4 w-4" />
              Download zip
            </button>
          )}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Photos
          </button>
        </div>
      </div>

      {/* Grid */}
      {assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ImageIcon className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No photos in this collection yet.</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-sm text-primary-text hover:underline"
          >
            Add photos
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {assets.map((asset, index) => (
            <PhotoCard
              key={asset.id}
              asset={asset}
              showQuickActions
              onRemove={handleRemove}
              onClick={() => openLightbox(index)}
            />
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && (
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
          onTrash={handleLightboxTrash}
        />
      )}

      {/* Add photos modal */}
      {showAddModal && (
        <AddPhotosModal
          collectionId={collectionId}
          existingIds={existingIds}
          onClose={() => setShowAddModal(false)}
          onAdded={handleAdded}
        />
      )}
    </div>
  );
}
