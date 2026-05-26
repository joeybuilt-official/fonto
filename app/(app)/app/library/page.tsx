// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 (UX consolidation) — unified asset-browsing surface.
//
// Replaces Photos / Timeline / Folders / Documents / Trash with a single
// AssetGrid wrapped by a chip strip. The chip strip drives URL query
// params that the existing `/api/v1/assets` endpoint already understands:
//
//   lifecycle  → ?lifecycle=active|archived|trashed
//   mime       → ?mime=image/|video/|application/
//   subtype    → ?subtype=document (when classification chip set)
//   path       → ?directoryPath=…   (exact level)
//   pathPrefix → ?directoryPathPrefix=…   (recursive)
//   from/to    → date range (client-side filter for now; server lacks)
//   favorite/ratingMin → ?favorite=1, ?ratingMin=N
//
// Memories / Timeline remain accessible as filters within Library (the
// chip layout differentiates by mime/date). Their dedicated routes still
// exist for now — Phase 5 ships the redirect layer that consolidates URLs.

"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { Loader2, Trash2, FolderTree, Image as ImageIcon, FileText, Film, Archive, Heart, Star, X } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { useToolbarState, type Lifecycle } from "@/lib/hooks/use-toolbar-state";

interface LifecycleOption {
  value: Lifecycle;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const LIFECYCLES: LifecycleOption[] = [
  { value: "active", label: "Active", icon: ImageIcon },
  { value: "archived", label: "Archived", icon: Archive },
  { value: "trashed", label: "Trash", icon: Trash2 },
];

interface MimeOption {
  value: string | null;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const MIMES: MimeOption[] = [
  { value: null, label: "All", icon: ImageIcon },
  { value: "image/", label: "Images", icon: ImageIcon },
  { value: "video/", label: "Videos", icon: Film },
  { value: "application/", label: "Documents", icon: FileText },
];

function LibraryContent() {
  const toolbar = useToolbarState({
    page: "library",
    availableFilters: [
      "type",
      "mime",
      "favorite",
      "ratingMin",
      "lifecycle",
      "directoryPath",
      "directoryPathPrefix",
      "from",
      "to",
    ],
  });

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Server-side fetch on every relevant chip change. The asset endpoint
  // already understands lifecycle, mime, subtype, directoryPath,
  // directoryPathPrefix, favorite, ratingMin — no shim layer needed.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      const sp = new URLSearchParams();
      sp.set("lifecycle", toolbar.filters.lifecycle);
      if (toolbar.filters.mime) sp.set("mime", toolbar.filters.mime);
      if (toolbar.filters.type) sp.set("subtype", toolbar.filters.type);
      if (toolbar.filters.favorite) sp.set("favorite", "1");
      if (toolbar.filters.ratingMin != null) {
        sp.set("ratingMin", String(toolbar.filters.ratingMin));
      }
      if (toolbar.filters.directoryPath != null) {
        sp.set("directoryPath", toolbar.filters.directoryPath);
      }
      if (toolbar.filters.directoryPathPrefix != null) {
        sp.set("directoryPathPrefix", toolbar.filters.directoryPathPrefix);
      }
      try {
        const r = await fetch(`/api/v1/assets?${sp.toString()}`);
        const d = (await r.json()) as { assets?: Asset[] };
        let list = (d.assets ?? []) as Asset[];

        // Date range is client-side until the list endpoint supports it.
        if (toolbar.filters.from) {
          const from = new Date(toolbar.filters.from).getTime();
          list = list.filter(
            (a) => new Date(a.capturedAt ?? a.createdAt).getTime() >= from
          );
        }
        if (toolbar.filters.to) {
          const to = new Date(toolbar.filters.to).getTime();
          list = list.filter(
            (a) => new Date(a.capturedAt ?? a.createdAt).getTime() <= to
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
        } else if (toolbar.filters.sort === "rating") {
          list = [...list].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        } else if (toolbar.filters.sort === "largest") {
          list = [...list].sort((a, b) => b.sizeBytes - a.sizeBytes);
        }

        if (toolbar.filters.q) {
          const needle = toolbar.filters.q.toLowerCase();
          list = list.filter(
            (a) =>
              a.filename.toLowerCase().includes(needle) ||
              (a.description?.toLowerCase().includes(needle) ?? false)
          );
        }

        setAssets(list);
      } finally {
        setLoading(false);
      }
    })();
  }, [
    toolbar.filters.lifecycle,
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.directoryPath,
    toolbar.filters.directoryPathPrefix,
    toolbar.filters.from,
    toolbar.filters.to,
    toolbar.filters.sort,
    toolbar.filters.q,
  ]);

  const openLightbox = useCallback((_id: string, index: number) => {
    setLightboxIndex(index);
  }, []);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  const isTrash = toolbar.filters.lifecycle === "trashed";

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Library"
        count={assets.length}
        toolbar={toolbar}
        searchPlaceholder="Search library…"
        sortOptions={["newest", "oldest", "name", "rating", "largest"]}
        filterKeys={["type", "favorite", "ratingMin"]}
        showDensity
        showSelect
      />

      <div className="px-4 space-y-3">
        <LibraryChipStrip toolbar={toolbar} />
        {isTrash && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Viewing Trash. Items here are deleted permanently after 30 days
            (see settings).
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="px-4">
          <AssetGrid
            assets={assets}
            toolbar={toolbar}
            viewMode="grid"
            onAssetClick={openLightbox}
          />
        </div>
      )}

      {lightboxIndex !== null && (
        <PhotoLightbox
          asset={assets[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
        />
      )}
    </div>
  );
}

function LibraryChipStrip({
  toolbar,
}: {
  toolbar: ReturnType<typeof useToolbarState>;
}) {
  const { filters, setFilters } = toolbar;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {/* Lifecycle chips — Active / Archived / Trash. Mutually exclusive. */}
      <div className="flex items-center gap-1 rounded-md border border-input bg-background p-0.5">
        {LIFECYCLES.map((l) => {
          const active = filters.lifecycle === l.value;
          const Icon = l.icon;
          return (
            <button
              key={l.value}
              onClick={() => setFilters({ lifecycle: l.value })}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3" />
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Mime chips — All / Images / Videos / Documents. */}
      <div className="flex items-center gap-1 rounded-md border border-input bg-background p-0.5">
        {MIMES.map((m) => {
          const active = (filters.mime ?? null) === m.value;
          const Icon = m.icon;
          return (
            <button
              key={m.label}
              onClick={() => setFilters({ mime: m.value })}
              className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3" />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Favorite chip — toggle. */}
      <button
        onClick={() => setFilters({ favorite: !filters.favorite })}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 transition-colors ${
          filters.favorite
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
      >
        <Heart className="h-3 w-3" fill={filters.favorite ? "currentColor" : "none"} />
        Favorites
      </button>

      {/* Rating chip — pop a 1..5 picker; simple cycle through values for v1. */}
      <button
        onClick={() => {
          const next =
            filters.ratingMin == null
              ? 4
              : filters.ratingMin >= 5
              ? null
              : filters.ratingMin + 1;
          setFilters({ ratingMin: next });
        }}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 transition-colors ${
          filters.ratingMin != null
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
        title="Cycle minimum rating: off → 4 → 5 → off"
      >
        <Star className="h-3 w-3" fill={filters.ratingMin != null ? "currentColor" : "none"} />
        {filters.ratingMin != null ? `${filters.ratingMin}+` : "Rating"}
      </button>

      {/* Folder filter — shown only when a path is active, w/ clear action. */}
      {(filters.directoryPath || filters.directoryPathPrefix) && (
        <button
          onClick={() =>
            setFilters({ directoryPath: null, directoryPathPrefix: null })
          }
          className="flex items-center gap-1 rounded-md border border-primary bg-primary px-2 py-1.5 text-primary-foreground"
          title="Clear folder filter"
        >
          <FolderTree className="h-3 w-3" />
          {filters.directoryPathPrefix ?? filters.directoryPath}
          <X className="h-3 w-3" />
        </button>
      )}

      {/* Date-range pair — collapsed display, click to clear. */}
      {(filters.from || filters.to) && (
        <button
          onClick={() => setFilters({ from: null, to: null })}
          className="flex items-center gap-1 rounded-md border border-primary bg-primary px-2 py-1.5 text-primary-foreground"
          title="Clear date range"
        >
          {filters.from ?? "…"} → {filters.to ?? "…"}
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <LibraryContent />
    </Suspense>
  );
}
