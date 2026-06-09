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

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Loader2, Trash2, FolderTree, Image as ImageIcon, FileText, Film, Archive, Heart, Star, X, CalendarDays, Tag as TagIcon, FolderPlus, Download, Smartphone, LayoutGrid, Users, Palette } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { VirtualizedTimeline, type TimelineMonth } from "../_components/virtualized-timeline";
import { useToolbarState, type Lifecycle } from "@/lib/hooks/use-toolbar-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProcessingNotice } from "../_components/processing-notice";

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

// Task 20 — library lenses. KIND is the library's primary partition; the lens
// selector is the headline control, the chip strip below it is power-filtering.
// "Moments" is the default (a missing ?kind= resolves to it); "All" clears the
// kind filter. Each lens maps to the server-side ?kind= preset that feeds both
// the timeline and its scrubber buckets. ("Saved" is deferred — see ADR D5.)
interface LensOption {
  value: string; // "moment" | "screenshot" | "graphics" | "document" | "video" | "all"
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const LENSES: LensOption[] = [
  { value: "moment", label: "Moments", icon: ImageIcon },
  { value: "screenshot", label: "Screenshots", icon: Smartphone },
  { value: "graphics", label: "Graphics", icon: Palette },
  { value: "document", label: "Documents", icon: FileText },
  { value: "video", label: "Videos", icon: Film },
  { value: "all", label: "All", icon: LayoutGrid },
];

const LENS_EMPTY: Record<string, string> = {
  moment: "No moments yet. Photos you take show up here.",
  screenshot: "No screenshots.",
  graphics: "No graphics yet. Logos, mockups, icons, and art show up here.",
  document: "No documents.",
  video: "No videos.",
  all: "No assets match the current filters.",
};

const CLASSIFICATION_CHIPS = [
  { value: "photo", label: "Photos" },
  { value: "screenshot", label: "Screenshots" },
  { value: "mockup", label: "Mockups" },
  { value: "logo", label: "Logos" },
  { value: "icon", label: "Icons" },
  { value: "scan", label: "Scans" },
  { value: "document", label: "Documents" },
] as const;

function LibraryContent() {
  const toolbar = useToolbarState({
    page: "library",
    availableFilters: [
      "type",
      "mime",
      "kind",
      "favorite",
      "ratingMin",
      "lifecycle",
      "directoryPath",
      "directoryPathPrefix",
      "from",
      "to",
      "groupId",
    ],
  });

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const placeFilter = searchParams.get("place");

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [buckets, setBuckets] = useState<TimelineMonth[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [directAsset, setDirectAsset] = useState<Asset | null>(null);
  const savedScrollRef = useRef(0);
  const prevLbIndexRef = useRef<number | null>(null);

  // The dated timeline is the default browse surface. It owns the capture-date
  // axis, so only the newest/oldest sort options apply to it; name / rating /
  // largest fall back to the flat chronological grid (which sorts client-side),
  // as do free-text search and explicit date-range bounds (neither is
  // expressible by the month-bucket scrubber / per-month windowed fetch).
  // Every other chip (lifecycle / mime / type / favorite / rating / folder)
  // maps to server-side params the timeline + buckets endpoints both honour.
  const timelineSort =
    toolbar.filters.sort === "newest" || toolbar.filters.sort === "oldest";
  const timelineMode =
    !toolbar.filters.q &&
    !toolbar.filters.from &&
    !toolbar.filters.to &&
    timelineSort;
  // Oldest just reverses the (newest-first) bucket order; the per-month fetch
  // is direction-agnostic so no extra backend support is needed.
  const orderedBuckets =
    toolbar.filters.sort === "oldest" ? [...buckets].reverse() : buckets;

  // Active lens — a missing ?kind= resolves to the default "Moments" lens.
  const activeLens = toolbar.filters.kind ?? "moment";

  // Server-side filter params shared by the buckets fetch and per-month
  // windowed fetch. Its identity changes whenever a filter changes, which is
  // exactly the signal VirtualizedTimeline uses to drop its per-month cache.
  const baseParams = useCallback(() => {
    const sp = new URLSearchParams();
    sp.set("lifecycle", toolbar.filters.lifecycle);
    // Task 20 — lens. Missing ?kind= => default "Moments"; "all" clears it.
    const lensKind = toolbar.filters.kind ?? "moment";
    if (lensKind !== "all") sp.set("kind", lensKind);
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
    if (toolbar.filters.groupId) {
      sp.set("group_id", toolbar.filters.groupId);
    }
    if (placeFilter) {
      sp.set("place", placeFilter);
    }
    return sp;
  }, [
    toolbar.filters.lifecycle,
    toolbar.filters.kind,
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.directoryPath,
    toolbar.filters.directoryPathPrefix,
    toolbar.filters.groupId,
    placeFilter,
  ]);

  // Load exactly one month's assets (captured-date order). Pages within the
  // [firstOfThisMonth, firstOfNextMonth) window until the boundary is crossed
  // so post-fetch mime/subtype filtering in the list route can't truncate the
  // month. Stable per filter set (depends on baseParams).
  const fetchMonth = useCallback(
    async (month: string): Promise<Asset[]> => {
      // Undated bucket — assets with no real capture date. They have no
      // captured_at to window on, so page through them in ingestion order
      // (created_at keyset) with the capturedState=undated server filter.
      if (month === "undated") {
        const base = baseParams();
        base.set("sort", "created");
        base.set("capturedState", "undated");
        base.set("limit", "200");
        let cursorBefore: string | null = null;
        let cursorId: string | null = null;
        const acc: Asset[] = [];
        for (let page = 0; page < 30; page++) {
          const sp = new URLSearchParams(base);
          if (cursorBefore) sp.set("createdBefore", cursorBefore);
          if (cursorId) sp.set("idBefore", cursorId);
          const r = await fetch(`/api/v1/assets?${sp.toString()}`);
          if (!r.ok) break;
          const d = (await r.json()) as {
            assets?: Asset[];
            nextCursor?: { createdBefore: string; idBefore: string } | null;
          };
          acc.push(...(d.assets ?? []));
          if (!d.nextCursor) break;
          cursorBefore = d.nextCursor.createdBefore;
          cursorId = d.nextCursor.idBefore;
        }
        return acc;
      }

      const [y, m] = month.split("-").map(Number);
      const firstOfThis = Date.UTC(y, m - 1, 1);
      const firstOfNext = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
      const base = baseParams();
      base.set("sort", "captured");
      base.set("capturedState", "dated");
      base.set("limit", "200");
      let cursorBefore = new Date(firstOfNext).toISOString();
      let cursorId: string | null = null;
      const acc: Asset[] = [];
      for (let page = 0; page < 12; page++) {
        const sp = new URLSearchParams(base);
        sp.set("capturedBefore", cursorBefore);
        if (cursorId) sp.set("idBefore", cursorId);
        const r = await fetch(`/api/v1/assets?${sp.toString()}`);
        if (!r.ok) break;
        const d = (await r.json()) as {
          assets?: Asset[];
          nextCursor?: { capturedBefore: string; idBefore: string } | null;
        };
        const rows = d.assets ?? [];
        for (const a of rows) {
          const t = new Date(a.capturedAt ?? a.createdAt).getTime();
          if (t >= firstOfThis && t < firstOfNext) acc.push(a);
        }
        const last = rows[rows.length - 1];
        if (!d.nextCursor || !last) break;
        const lastT = new Date(last.capturedAt ?? last.createdAt).getTime();
        if (lastT < firstOfThis) break;
        cursorBefore = d.nextCursor.capturedBefore;
        cursorId = d.nextCursor.idBefore;
      }
      return acc;
    },
    [baseParams]
  );

  const handleLoadedAssets = useCallback((a: Asset[]) => setAssets(a), []);

  // Timeline tile selection — mirrors AssetGrid: shift-click ranges over the
  // loaded ordered set, plain click toggles. `assets` here is the flattened
  // loaded-in-order list surfaced by the timeline.
  const lastSelectedRef = useRef<string | null>(null);
  const handleTimelineSelect = useCallback(
    (assetId: string, e?: React.MouseEvent) => {
      if (e?.shiftKey && lastSelectedRef.current) {
        toolbar.selectRange(
          assets.map((a) => a.id),
          lastSelectedRef.current,
          assetId
        );
      } else {
        toolbar.toggleSelect(assetId);
      }
      lastSelectedRef.current = assetId;
    },
    [assets, toolbar]
  );

  // Bulk-action bar (shown when ≥1 tile selected): add-to-collection,
  // download, move-to-trash. `refreshKey` bumps remount the timeline after a
  // mutation so trashed tiles disappear (the per-month cache can't self-evict).
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    fetch("/api/v1/collections")
      .then((r) => r.json() as Promise<{ collections?: { id: string; name: string }[] }>)
      .then((d) => setCollections(d.collections ?? []))
      .catch(() => undefined);
  }, []);

  const handleBatchAddToCollection = useCallback(
    async (collectionId: string) => {
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
      toolbar.setSelectMode(false);
    },
    [toolbar]
  );

  const handleBatchDownload = useCallback(async () => {
    const ids = Array.from(toolbar.selectedIds);
    const r = await fetch("/api/v1/assets/urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, variant: "original" }),
    });
    const d = (await r.json()) as { urls?: Record<string, string> };
    for (const id of ids) {
      const url = d.urls?.[id];
      if (!url) continue;
      const asset = assets.find((a) => a.id === id);
      const a = document.createElement("a");
      a.href = url;
      a.download = asset?.filename ?? id;
      a.click();
      await new Promise((res) => setTimeout(res, 200));
    }
  }, [assets, toolbar.selectedIds]);

  const handleBatchTrash = useCallback(async () => {
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
    toolbar.clearSelection();
    toolbar.setSelectMode(false);
    setRefreshKey((k) => k + 1);
  }, [toolbar]);

  // Lightbox is URL-based so back button restores chip state.
  // Opening pushes ?lb=<id>; closing calls router.back().
  const lbId = searchParams.get("lb");
  const lbIndex = lbId != null ? assets.findIndex((a) => a.id === lbId) : null;
  const lightboxIndex = lbIndex !== null && lbIndex >= 0 ? lbIndex : null;

  // Timeline scrubber domain — full-library month counts under the active
  // filters. Only needed when the timeline is the active surface.
  useEffect(() => {
    if (!timelineMode) return;
    let cancelled = false;
    setBucketsLoading(true);
    setLoadError(false);
    fetch(`/api/v1/assets/buckets?${baseParams().toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`buckets ${r.status}`);
        return (await r.json()) as { buckets?: TimelineMonth[] };
      })
      .then((d) => {
        if (!cancelled) setBuckets(d.buckets ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setBuckets([]);
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBucketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [timelineMode, baseParams, refreshKey]);

  // Flat-grid fallback fetch — only runs when search / date-range force the
  // non-timeline surface. Loads the whole filtered set + filters client-side.
  useEffect(() => {
    if (timelineMode) return;
    void (async () => {
      setLoading(true);
      setLoadError(false);
      const sp = new URLSearchParams();
      sp.set("lifecycle", toolbar.filters.lifecycle);
      const lensKind = toolbar.filters.kind ?? "moment";
      if (lensKind !== "all") sp.set("kind", lensKind);
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
        if (!r.ok) throw new Error(`assets ${r.status}`);
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
      } catch {
        setAssets([]);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [
    timelineMode,
    toolbar.filters.lifecycle,
    toolbar.filters.kind,
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
    refreshKey,
  ]);

  const openLightbox = useCallback((id: string, _index: number) => {
    savedScrollRef.current = window.scrollY;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("lb", id);
    router.push(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const navLightbox = useCallback((delta: number) => {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("lb", assets[next].id);
      router.replace(`${pathname}?${sp.toString()}`);
    }
  }, [lightboxIndex, assets, searchParams, router, pathname]);

  const closeLightbox = useCallback(() => {
    router.back();
  }, [router]);

  // Restore scroll position when lightbox closes.
  useEffect(() => {
    if (prevLbIndexRef.current !== null && lightboxIndex === null) {
      const saved = savedScrollRef.current;
      requestAnimationFrame(() => {
        window.scrollTo({ top: saved, behavior: "instant" });
      });
    }
    prevLbIndexRef.current = lightboxIndex;
  }, [lightboxIndex]);

  // Fetch a specific asset by ID when it isn't in the current filtered list
  // (e.g. archived asset opened via external deep-link URL).
  useEffect(() => {
    if (!lbId || (!timelineMode && loading)) {
      if (!lbId) setDirectAsset(null);
      return;
    }
    if (lbIndex !== null && lbIndex >= 0) {
      setDirectAsset(null);
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`/api/v1/assets/${lbId}`);
        if (!r.ok) return;
        const d = (await r.json()) as { asset?: Asset };
        setDirectAsset(d.asset ?? null);
      } catch { /* best-effort */ }
    })();
  }, [lbId, lbIndex, loading, timelineMode]);

  const isTrash = toolbar.filters.lifecycle === "trashed";
  const timelineTotal = timelineMode
    ? buckets.reduce((s, b) => s + b.count, 0)
    : assets.length;

  return (
    <div className="space-y-3">
      <div className="px-4 pt-1">
        <ProcessingNotice />
      </div>
      <AssetPageToolbar
        title="Library"
        count={timelineTotal}
        toolbar={toolbar}
        searchPlaceholder="Search library…"
        sortOptions={["newest", "oldest", "name", "rating", "largest"]}
        filterKeys={["type", "mime", "from", "to", "directoryPathPrefix", "favorite", "ratingMin", "lifecycle"]}
        showDensity
        showSelect
      />

      <div className="px-4 space-y-3">
        <LensSelector
          active={activeLens}
          onChange={(value) =>
            toolbar.setFilters({ kind: value === "moment" ? null : value })
          }
        />
        <LibraryActivePills toolbar={toolbar} />
        {/* Mobile uses the toolbar's Filter popover (lifecycle/mime/type/etc. all live there).
            Desktop keeps the inline chip strip for one-tap toggles. */}
        <div className="hidden md:block">
          <LibraryChipStrip toolbar={toolbar} />
        </div>
        {isTrash && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Viewing Trash. Items here are deleted permanently after 30 days
            (see settings).
          </div>
        )}
      </div>

      {timelineMode ? (
        bucketsLoading && buckets.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : loadError ? (
          <LibraryErrorState onRetry={() => setRefreshKey((k) => k + 1)} />
        ) : buckets.length === 0 ? (
          <LibraryEmptyState toolbar={toolbar} activeLens={activeLens} placeFilter={placeFilter} />
        ) : (
          <div className="px-4">
            <VirtualizedTimeline
              key={`${toolbar.filters.sort}-${refreshKey}`}
              buckets={orderedBuckets}
              fetchMonth={fetchMonth}
              onAssetClick={(a) => openLightbox(a.id, 0)}
              onLoadedAssetsChange={handleLoadedAssets}
              selectMode={toolbar.selectMode}
              selectedIds={toolbar.selectedIds}
              onToggleSelect={handleTimelineSelect}
              density={toolbar.view.density}
              groupByEvents={activeLens === "moment"}
            />
          </div>
        )
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : loadError ? (
        <LibraryErrorState onRetry={() => setRefreshKey((k) => k + 1)} />
      ) : assets.length === 0 ? (
        <LibraryEmptyState toolbar={toolbar} activeLens={activeLens} placeFilter={placeFilter} />
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

      {lightboxIndex !== null ? (
        <PhotoLightbox
          asset={assets[lightboxIndex]}
          onClose={closeLightbox}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
        />
      ) : directAsset ? (
        <PhotoLightbox
          asset={directAsset}
          onClose={closeLightbox}
          onPrev={() => {}}
          onNext={() => {}}
          hasPrev={false}
          hasNext={false}
        />
      ) : null}

      <BatchActionBar
        count={toolbar.selectedIds.size}
        onAddToCollection={() => setShowCollectionModal(true)}
        onDownload={handleBatchDownload}
        onTrash={handleBatchTrash}
        onClear={() => {
          toolbar.clearSelection();
          toolbar.setSelectMode(false);
        }}
      />
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

function BatchActionBar({
  count,
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
  if (count === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 flex items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-2.5 shadow-xl backdrop-blur">
      <span className="mr-2 text-sm font-medium text-foreground">
        {count} selected
      </span>
      <button
        onClick={onAddToCollection}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <FolderPlus className="h-3.5 w-3.5" />
        Add to collection
      </button>
      <button
        onClick={onDownload}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/80"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
      <button
        onClick={onTrash}
        className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Move to trash
      </button>
      <button
        onClick={onClear}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
  collections: { id: string; name: string }[];
  onSelect: (collectionId: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
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
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No collections yet.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto py-1">
            {collections.map((col) => (
              <button
                key={col.id}
                onClick={() => onSelect(col.id)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted"
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

function DateRangeChip({
  from,
  to,
  onChange,
}: {
  from: string | null;
  to: string | null;
  onChange: (patch: { from?: string | null; to?: string | null }) => void;
}) {
  const active = !!(from || to);
  return (
    <Popover>
      <PopoverTrigger
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
      >
        <CalendarDays className="h-3 w-3" />
        {active ? `${from ?? "…"} → ${to ?? "…"}` : "Date"}
        {active && (
          <X
            className="h-3 w-3"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ from: null, to: null });
            }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start" sideOffset={6}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Date range
        </p>
        <div className="flex items-center gap-2 pt-1.5">
          <input
            type="date"
            value={from ?? ""}
            onChange={(e) => onChange({ from: e.target.value || null })}
            aria-label="From"
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <input
            type="date"
            value={to ?? ""}
            onChange={(e) => onChange({ to: e.target.value || null })}
            aria-label="To"
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        {active && (
          <button
            onClick={() => onChange({ from: null, to: null })}
            className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface FolderEntry {
  path: string;
  assetCount: number;
}

function FolderChip({
  activePath,
  onChange,
}: {
  activePath: string | null;
  onChange: (path: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const active = activePath != null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFolderLoading(true);
    fetch("/api/v1/folders/tree")
      .then((r) => r.json() as Promise<{ paths: FolderEntry[]; rootAssetCount: number }>)
      .then((d) => {
        if (!cancelled) setFolders(d.paths ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setFolderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={(v: boolean) => setOpen(v)}>
      <PopoverTrigger
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
      >
        <FolderTree className="h-3 w-3" />
        {active ? activePath : "Folder"}
        {active && (
          <X
            className="h-3 w-3"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 max-h-64 overflow-y-auto" align="start" sideOffset={6}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Folder
        </p>
        {folderLoading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-0.5">
            <button
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={`rounded px-2 py-1 text-left text-xs transition-colors ${
                activePath === null
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              All folders
            </button>
            {folders.map((f) => (
              <button
                key={f.path}
                onClick={() => {
                  onChange(f.path);
                  setOpen(false);
                }}
                className={`rounded px-2 py-1 text-left text-xs transition-colors ${
                  activePath === f.path
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {f.path}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ClassificationChip({
  activeType,
  onChange,
}: {
  activeType: string | null;
  onChange: (type: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = activeType != null;
  const label = active
    ? (CLASSIFICATION_CHIPS.find((c) => c.value === activeType)?.label ?? activeType)
    : "Type";

  return (
    <Popover open={open} onOpenChange={(v: boolean) => setOpen(v)}>
      <PopoverTrigger
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
          active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
      >
        <TagIcon className="h-3 w-3" />
        {label}
        {active && (
          <X
            className="h-3 w-3"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start" sideOffset={6}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Type
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CLASSIFICATION_CHIPS.map((c) => {
            const isActive = activeType === c.value;
            return (
              <button
                key={c.value}
                onClick={() => {
                  onChange(isActive ? null : c.value);
                  setOpen(false);
                }}
                className={`h-7 rounded-full border px-2.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-muted"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LensSelector({
  active,
  onChange,
}: {
  active: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto pb-0.5"
      role="tablist"
      aria-label="Library lens"
    >
      {LENSES.map((lens) => {
        const isActive = active === lens.value;
        const Icon = lens.icon;
        return (
          <button
            key={lens.value}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(lens.value)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {lens.label}
          </button>
        );
      })}
    </div>
  );
}

// Phase 5 — filter-aware empty state. The KIND-keyed LENS_EMPTY copy
// is only correct when KIND is the ONLY thing filtering; if the user
// also set favorite/rating/date/etc., "No documents yet." reads as
// "there are no documents" when really "no documents match your filters."
// Distinguish: at least one non-lens filter set → filter-clear CTA;
// else → kind-keyed welcome copy.
function LibraryEmptyState({
  toolbar,
  activeLens,
  placeFilter,
}: {
  toolbar: ReturnType<typeof useToolbarState>;
  activeLens: string;
  placeFilter?: string | null;
}) {
  const f = toolbar.filters;
  const router = useRouter();
  const pathname = usePathname();
  const filterCount =
    (f.lifecycle && f.lifecycle !== "active" ? 1 : 0) +
    (f.mime ? 1 : 0) +
    (f.favorite ? 1 : 0) +
    (f.ratingMin != null ? 1 : 0) +
    (f.type ? 1 : 0) +
    (f.directoryPathPrefix || f.directoryPath ? 1 : 0) +
    (f.from || f.to ? 1 : 0) +
    (f.groupId ? 1 : 0) +
    (f.q ? 1 : 0) +
    (placeFilter ? 1 : 0);

  if (filterCount > 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ImageIcon className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No {activeLens === "all" ? "assets" : activeLens === "moment" ? "moments" : activeLens + "s"}{" "}
          match these filters.
        </p>
        <button
          onClick={() => {
            toolbar.resetFilters();
            if (placeFilter) router.replace(pathname);
          }}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <ImageIcon className="h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {LENS_EMPTY[activeLens] ?? "No assets in your library yet."}
      </p>
    </div>
  );
}

// Phase 5 — error w/ retry. Used by both timeline and flat-grid fetch paths
// when the buckets or assets fetch throws / returns non-2xx. Retry bumps
// refreshKey, which is in the dependency list of both effects.
function LibraryErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <ImageIcon className="h-10 w-10 text-destructive/70" />
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load your library. Check your connection and retry.
      </p>
      <button
        onClick={onRetry}
        className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
      >
        Retry
      </button>
    </div>
  );
}

// Phase 2 redesign — active-filters pill row. Surfaces every set filter w/
// an X to remove it. Renders at every viewport so the user always sees
// what's filtering their grid (the mobile Filter popover otherwise hides
// state behind a button). Empty when no filters are set → renders null.
function LibraryActivePills({
  toolbar,
}: {
  toolbar: ReturnType<typeof useToolbarState>;
}) {
  const { filters, setFilters } = toolbar;
  const pills: { key: string; label: string; clear: () => void }[] = [];

  if (filters.lifecycle && filters.lifecycle !== "active") {
    pills.push({
      key: "lifecycle",
      label: filters.lifecycle[0].toUpperCase() + filters.lifecycle.slice(1),
      clear: () => setFilters({ lifecycle: "active" }),
    });
  }
  if (filters.mime) {
    const m = filters.mime;
    const label =
      m === "image/" ? "Images" :
      m === "video/" ? "Videos" :
      m === "application/" ? "Documents" :
      m === "application/pdf" ? "PDFs" :
      m;
    pills.push({ key: "mime", label, clear: () => setFilters({ mime: null }) });
  }
  if (filters.kind) {
    pills.push({
      key: "kind",
      label: filters.kind[0].toUpperCase() + filters.kind.slice(1),
      clear: () => setFilters({ kind: null }),
    });
  }
  if (filters.favorite) {
    pills.push({ key: "favorite", label: "Favorites", clear: () => setFilters({ favorite: false }) });
  }
  if (filters.ratingMin != null) {
    pills.push({
      key: "rating",
      label: `${filters.ratingMin}+ stars`,
      clear: () => setFilters({ ratingMin: null }),
    });
  }
  if (filters.type) {
    pills.push({
      key: "type",
      label: filters.type[0].toUpperCase() + filters.type.slice(1),
      clear: () => setFilters({ type: null }),
    });
  }
  if (filters.directoryPathPrefix || filters.directoryPath) {
    const p = filters.directoryPathPrefix ?? filters.directoryPath ?? "";
    const last = p.replace(/\/$/, "").split("/").filter(Boolean).pop();
    pills.push({
      key: "folder",
      label: last ? `📁 ${last}` : "📁 All folders",
      clear: () => setFilters({ directoryPathPrefix: null, directoryPath: null }),
    });
  }
  if (filters.from || filters.to) {
    const range =
      filters.from && filters.to ? `${filters.from} → ${filters.to}` :
      filters.from ? `From ${filters.from}` :
      `Through ${filters.to}`;
    pills.push({
      key: "date",
      label: range,
      clear: () => setFilters({ from: null, to: null }),
    });
  }
  if (filters.groupId) {
    pills.push({
      key: "group",
      label: "Group",
      clear: () => setFilters({ groupId: null }),
    });
  }
  if (filters.q) {
    pills.push({ key: "q", label: `“${filters.q}”`, clear: () => setFilters({ q: "" }) });
  }

  if (!pills.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {pills.map((p) => (
        <button
          key={p.key}
          onClick={p.clear}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary hover:bg-primary/20 transition-colors"
        >
          <span>{p.label}</span>
          <span aria-hidden className="text-base leading-none">×</span>
          <span className="sr-only">Remove filter</span>
        </button>
      ))}
      {pills.length > 1 && (
        <button
          onClick={() => toolbar.resetFilters()}
          className="ml-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </button>
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

      {/* Classification chip — popover w/ active class list (FU-C3). */}
      <ClassificationChip
        activeType={filters.type}
        onChange={(type) => setFilters({ type })}
      />

      {/* Folder chip — opens folder-tree popover, drives directoryPathPrefix. */}
      <FolderChip
        activePath={filters.directoryPathPrefix ?? filters.directoryPath}
        onChange={(path) =>
          setFilters({ directoryPathPrefix: path, directoryPath: null })
        }
      />

      {/* Date-range chip — opens date popover. */}
      <DateRangeChip
        from={filters.from}
        to={filters.to}
        onChange={(patch) => setFilters(patch)}
      />

      {/* People group chip — filter library to a person-relationship group. */}
      <PeopleGroupChip
        activeGroupId={filters.groupId ?? null}
        onChange={(groupId) => setFilters({ groupId })}
      />
    </div>
  );
}

interface PersonGroupChipEntry { id: string; name: string; color: string; }

function PeopleGroupChip({
  activeGroupId,
  onChange,
}: {
  activeGroupId: string | null;
  onChange: (groupId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<PersonGroupChipEntry[]>([]);

  useEffect(() => {
    fetch("/api/v1/person-groups")
      .then((r) => r.json())
      .then((d: { groups?: PersonGroupChipEntry[] }) => {
        setGroups(d.groups ?? []);
      })
      .catch(() => {});
  }, []);

  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const isActive = activeGroupId !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm transition-colors ${
          isActive
            ? "border-transparent text-white"
            : "border-input bg-background text-muted-foreground hover:text-foreground"
        }`}
        style={isActive && activeGroup ? { backgroundColor: activeGroup.color } : undefined}
      >
        <Users className="h-3 w-3" />
        {activeGroup ? activeGroup.name : "People"}
        {isActive && (
          <X
            className="h-3 w-3 ml-0.5 opacity-70 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setOpen(false);
            }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="start">
        <div className="flex flex-col gap-1">
          {groups.length === 0 && (
            <p className="text-xs text-muted-foreground px-1">No groups yet.</p>
          )}
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                onChange(activeGroupId === g.id ? null : g.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs text-left transition-colors hover:bg-muted/50 ${
                activeGroupId === g.id ? "font-medium" : ""
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: g.color }}
              />
              {g.name}
              {activeGroupId === g.id && <span className="ml-auto text-muted-foreground">✓</span>}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <LibraryContent />
    </Suspense>
  );
}
