// SPDX-License-Identifier: MIT
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
import Link from "next/link";
import { Loader2, Trash2, FolderTree, Image as ImageIcon, FileText, Film, Archive, Heart, Star, X, CalendarDays, Tag as TagIcon, FolderPlus, Download, Smartphone, LayoutGrid, Users, Palette, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { VirtualizedTimeline, type TimelineMonth } from "../_components/virtualized-timeline";
import { useToolbarState, type Lifecycle } from "@/lib/hooks/use-toolbar-state";
import { useSnackbar } from "@/components/ui/snackbar";
import { downloadAssetsZip } from "@/lib/download-zip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProcessingNotice } from "../_components/processing-notice";
import { ScopeSelector } from "../shoots/_components/scope-selector";
import { useSavedScopeDefault } from "@/lib/hooks/use-saved-scope-default";
import { useFeatureFlags } from "@/lib/hooks/use-feature-flags";
import { trackLibrary } from "@/lib/telemetry/library";
import {
  LibrarySurfaceControl,
  computeKindParam,
  type LibrarySurface,
} from "../_components/library-surface-control";
import { LibraryFilesView } from "../_components/library-files-view";
import { GridSkeleton } from "../_components/grid-skeleton";
import { ListErrorState } from "../_components/list-states";

const SURFACE_LS_KEY = "fonto:library:surface";

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
  const toast = useSnackbar();

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
  // Photos/Files split (feature-flagged). Computed up here because it gates the
  // timeline machinery below. When ON, the flat KIND lens row is replaced by a
  // Photos/Files segmented control + an Inbox holding area for unclassified
  // assets; only the Photos surface drives the timeline. When OFF, everything
  // is inert and the page behaves exactly as before. See
  // plans/photos-vs-files-split/plan.md.
  const flags = useFeatureFlags();
  const splitOn = flags.librarySurfaceSplit;
  const surfaceParam = searchParams.get("surface");
  const surface: LibrarySurface = splitOn
    ? surfaceParam === "files" || surfaceParam === "unsorted" || surfaceParam === "photos"
      ? surfaceParam
      : "photos"
    : "photos";
  const splitLens = searchParams.get("lens") ?? "all";
  const splitKind = splitOn ? computeKindParam(surface, splitLens) : null;
  const photosActive = !splitOn || surface === "photos";

  const timelineSort =
    toolbar.filters.sort === "newest" || toolbar.filters.sort === "oldest";
  const timelineMode =
    photosActive &&
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

  const [unsortedCount, setUnsortedCount] = useState(0);

  // First-paint surface restore: when the flag is on and the URL carries no
  // ?surface=, hop to the last-used surface (persisted) without a hydration
  // mismatch (the initial render is always "photos").
  useEffect(() => {
    if (!splitOn || surfaceParam) return;
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(SURFACE_LS_KEY);
    } catch {
      /* private mode */
    }
    if (last === "files" || last === "unsorted") {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("surface", last);
      router.replace(`${pathname}?${sp.toString()}`);
    }
  }, [splitOn, surfaceParam, searchParams, router, pathname]);

  // Inbox pending count for the banner badge (exact, via the buckets sum).
  useEffect(() => {
    if (!splitOn) return;
    let alive = true;
    fetch("/api/v1/assets/buckets?unclassified=1")
      .then((r) => (r.ok ? r.json() : { buckets: [] }))
      .then((d: { buckets?: { count: number }[] }) => {
        if (alive) setUnsortedCount((d.buckets ?? []).reduce((s, b) => s + b.count, 0));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [splitOn, surface]);

  const setSurface = useCallback(
    (s: LibrarySurface) => {
      try {
        window.localStorage.setItem(SURFACE_LS_KEY, s);
      } catch {
        /* private mode */
      }
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("surface", s);
      sp.delete("lens");
      sp.delete("kind");
      if (s !== "files") sp.delete("q");
      router.replace(`${pathname}?${sp.toString()}`);
      trackLibrary("library_surface_toggle", { to: s });
    },
    [searchParams, router, pathname]
  );

  const setSplitLens = useCallback(
    (lens: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (lens === "all") sp.delete("lens");
      else sp.set("lens", lens);
      router.replace(`${pathname}?${sp.toString()}`);
      trackLibrary("library_lens_select", { surface, lens });
    },
    [searchParams, router, pathname, surface]
  );

  // ADR 0008 Phase 5 — apply the saved default-scope preference on first paint
  // when no `?scope=` is in the URL. The selector chip strip takes over once
  // the user clicks; this hook only fires when the URL is unset.
  useSavedScopeDefault();

  // Server-side filter params shared by the buckets fetch and per-month
  // windowed fetch. Its identity changes whenever a filter changes, which is
  // exactly the signal VirtualizedTimeline uses to drop its per-month cache.
  const baseParams = useCallback(() => {
    const sp = new URLSearchParams();
    sp.set("lifecycle", toolbar.filters.lifecycle);
    if (splitOn) {
      // Photos surface: "all" → moment,video; single lens → that kind.
      if (splitKind) sp.set("kind", splitKind);
    } else {
      // Task 20 — lens. Missing ?kind= => default "Moments"; "all" clears it.
      const lensKind = toolbar.filters.kind ?? "moment";
      if (lensKind !== "all") sp.set("kind", lensKind);
    }
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
    splitOn,
    splitKind,
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
          // Throw (not break) so a transient failure surfaces as a retryable
          // month in VirtualizedTimeline rather than being cached as empty.
          if (!r.ok) throw new Error(`assets ${r.status}`);
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
        // Throw (not break) so a transient failure surfaces as a retryable
        // month in VirtualizedTimeline rather than being cached as empty.
        if (!r.ok) throw new Error(`assets ${r.status}`);
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
      // A rejected fetch OR a non-2xx response is a failure — the old code
      // awaited Promise.all and reported success even on HTTP 4xx/5xx.
      const failedIds = ids.filter(
        (_id, i) =>
          results[i].status === "rejected" ||
          !(results[i] as PromiseFulfilledResult<Response>).value.ok
      );
      const okCount = ids.length - failedIds.length;
      setShowCollectionModal(false);
      if (failedIds.length === 0) {
        toolbar.clearSelection();
        toolbar.setSelectMode(false);
        toast.add({ title: `Added ${okCount} to collection` });
      } else {
        // Keep the failures selected so the user can retry just those.
        toolbar.clearSelection();
        for (const id of failedIds) toolbar.toggleSelect(id);
        toast.add({
          title: `Couldn't add ${failedIds.length} of ${ids.length}`,
          description: "Left selected — try again.",
          priority: "high",
        });
      }
    },
    [toolbar, toast]
  );

  const handleBatchDownload = useCallback(() => {
    // M8 — one streamed zip instead of N separate browser downloads.
    downloadAssetsZip(Array.from(toolbar.selectedIds));
  }, [toolbar.selectedIds]);

  const handleBatchTrash = useCallback(async () => {
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
    // A rejected fetch OR a non-2xx response is a failure — the old code
    // reported success even when the PATCH 4xx/5xx'd.
    const failedIds = ids.filter(
      (_id, i) =>
        results[i].status === "rejected" ||
        !(results[i] as PromiseFulfilledResult<Response>).value.ok
    );
    const okCount = ids.length - failedIds.length;
    if (failedIds.length === 0) {
      toolbar.clearSelection();
      toolbar.setSelectMode(false);
      toast.add({ title: `Moved ${okCount} to trash` });
    } else {
      // Keep the failures selected for retry.
      toolbar.clearSelection();
      for (const id of failedIds) toolbar.toggleSelect(id);
      toast.add({
        title: `Couldn't trash ${failedIds.length} of ${ids.length}`,
        description: "Left selected — try again.",
        priority: "high",
      });
    }
    // Only bump the refresh when something actually moved, so the timeline
    // doesn't needlessly remount on a total failure.
    if (okCount > 0) setRefreshKey((k) => k + 1);
  }, [toolbar, toast]);

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
    // The Files surface owns its own fetch (LibraryFilesView). The flat grid
    // here serves the legacy view, the Inbox surface, and the search/date-range
    // fallback for Photos.
    if (splitOn && surface === "files") return;
    void (async () => {
      setLoading(true);
      setLoadError(false);
      const sp = new URLSearchParams();
      sp.set("lifecycle", toolbar.filters.lifecycle);
      if (splitOn && surface === "unsorted") {
        sp.set("unclassified", "1");
      } else if (splitOn) {
        if (splitKind) sp.set("kind", splitKind);
      } else {
        const lensKind = toolbar.filters.kind ?? "moment";
        if (lensKind !== "all") sp.set("kind", lensKind);
      }
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
    splitOn,
    surface,
    splitKind,
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
        <ScopeSelector />
        {splitOn ? (
          <LibrarySurfaceControl
            surface={surface}
            lens={splitLens}
            unsortedCount={unsortedCount}
            onSurface={setSurface}
            onLens={setSplitLens}
          />
        ) : (
          <LensSelector
            active={activeLens}
            onChange={(value) =>
              toolbar.setFilters({ kind: value === "moment" ? null : value })
            }
          />
        )}
        <LibraryActivePills toolbar={toolbar} />
        {/* Mobile uses the toolbar's Filter popover (lifecycle/mime/type/etc. all live there).
            Desktop keeps the inline chip strip for one-tap toggles. The chip
            strip is Photos-only under the split (Files has its own search). */}
        {photosActive && (
          <div className="hidden md:block">
            <LibraryChipStrip toolbar={toolbar} />
          </div>
        )}
        {isTrash && (
          <div className="flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-small)] bg-[var(--ft-color-error-container)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] text-[var(--ft-color-on-error-container)]">
            <Trash2 className="h-3.5 w-3.5" />
            Viewing Trash. Items here are deleted permanently after 30 days
            (see settings).
          </div>
        )}
      </div>

      {splitOn && surface === "files" ? (
        <LibraryFilesView
          kindParam={splitKind}
          directoryPathPrefix={toolbar.filters.directoryPathPrefix}
          onOpenFolder={(path) =>
            toolbar.setFilters({ directoryPathPrefix: path, directoryPath: null })
          }
        />
      ) : timelineMode ? (
        bucketsLoading && buckets.length === 0 ? (
          <div className="px-4">
            <GridSkeleton density={toolbar.view.density} />
          </div>
        ) : loadError ? (
          <LibraryError onRetry={() => setRefreshKey((k) => k + 1)} />
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
        <div className="px-4">
          <GridSkeleton density={toolbar.view.density} />
        </div>
      ) : loadError ? (
        <LibraryError onRetry={() => setRefreshKey((k) => k + 1)} />
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
          prevAssetId={lightboxIndex > 0 ? assets[lightboxIndex - 1]?.id ?? null : null}
          nextAssetId={
            lightboxIndex < assets.length - 1 ? assets[lightboxIndex + 1]?.id ?? null : null
          }
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
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container-high)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] shadow-[var(--ft-elev-3)] backdrop-blur">
      <span className="mr-2 text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-surface)]">
        {count} selected
      </span>
      <button
        onClick={onAddToCollection}
        className="inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-secondary-container)] transition-colors hover:brightness-95"
      >
        <FolderPlus className="h-3.5 w-3.5" />
        Add to collection
      </button>
      <button
        onClick={onDownload}
        className="inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-secondary-container)] transition-colors hover:brightness-95"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
      <button
        onClick={onTrash}
        className="inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-error-container)] px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-error-container)] transition-colors hover:brightness-95"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Move to trash
      </button>
      <button
        onClick={onClear}
        className="rounded-[var(--ft-shape-full)] p-1.5 text-[var(--ft-color-on-surface-variant)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ft-color-scrim)]/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container-high)] shadow-[var(--ft-elev-3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-4)] py-[var(--ft-space-3)]">
          <p className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-medium text-[var(--ft-color-on-surface)]">Add to Collection</p>
          <button onClick={onClose} className="text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        {collections.length === 0 ? (
          <p className="px-[var(--ft-space-4)] py-[var(--ft-space-6)] text-center text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
            No collections yet.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto py-1">
            {collections.map((col) => (
              <button
                key={col.id}
                onClick={() => onSelect(col.id)}
                className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          active
            ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
          Date range
        </p>
        <div className="flex items-center gap-[var(--ft-space-2)] pt-1.5">
          <input
            type="date"
            value={from ?? ""}
            onChange={(e) => onChange({ from: e.target.value || null })}
            aria-label="From"
            className="h-8 flex-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-3)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] focus:border-[var(--ft-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
          />
          <span className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">→</span>
          <input
            type="date"
            value={to ?? ""}
            onChange={(e) => onChange({ to: e.target.value || null })}
            aria-label="To"
            className="h-8 flex-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-3)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] focus:border-[var(--ft-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
          />
        </div>
        {active && (
          <button
            onClick={() => onChange({ from: null, to: null })}
            className="mt-1 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          active
            ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
          Folder
        </p>
        {folderLoading ? (
          <div className="flex items-center gap-[var(--ft-space-2)] py-2 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
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
              className={`rounded-[var(--ft-shape-extra-small)] px-[var(--ft-space-2)] py-1 text-left text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] transition-colors ${
                activePath === null
                  ? "bg-[var(--ft-color-secondary-container)] font-medium text-[var(--ft-color-on-secondary-container)]"
                  : "text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
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
                className={`rounded-[var(--ft-shape-extra-small)] px-[var(--ft-space-2)] py-1 text-left text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] transition-colors ${
                  activePath === f.path
                    ? "bg-[var(--ft-color-secondary-container)] font-medium text-[var(--ft-color-on-secondary-container)]"
                    : "text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          active
            ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
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
                className={`inline-flex h-8 items-center justify-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                    : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
            className={`inline-flex h-8 shrink-0 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
              isActive
                ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
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
      <div className="flex flex-col items-center gap-[var(--ft-space-3)] py-16 text-center">
        <ImageIcon className="h-10 w-10 text-[var(--ft-color-on-surface-variant)]" />
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          No {activeLens === "all" ? "assets" : activeLens === "moment" ? "moments" : activeLens + "s"}{" "}
          match these filters.
        </p>
        <button
          onClick={() => {
            toolbar.resetFilters();
            if (placeFilter) router.replace(pathname);
          }}
          className="inline-flex h-8 items-center justify-center rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-4)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]"
        >
          Clear filters
        </button>
      </div>
    );
  }

  // Zero-content first-run: no filters, nothing in the library. This is the
  // primary onboarding moment — give it a real next action (upload direct, or
  // bulk-import from Google/Amazon) rather than a dead-end message.
  return (
    <div className="flex flex-col items-center gap-[var(--ft-space-4)] py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[var(--ft-shape-large)] bg-[var(--ft-color-primary-container)] text-[var(--ft-color-on-primary-container)]">
        <ImageIcon className="h-7 w-7" />
      </div>
      <div className="space-y-1">
        <p className="text-[length:var(--ft-type-title-medium-size)] font-medium leading-[var(--ft-type-title-medium-line)] text-[var(--ft-color-on-surface)]">
          {LENS_EMPTY[activeLens] ?? "No assets in your library yet."}
        </p>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          Add your photos to get started.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-[var(--ft-space-2)]">
        <Button variant="filled" render={<Link href="/app/updates?section=uploads" />}>
          <Upload className="h-4 w-4" />
          Upload photos
        </Button>
        <Button variant="outlined" render={<Link href="/app/imports" />}>
          Import from Google or Amazon
        </Button>
      </div>
    </div>
  );
}

// Phase 5 — error w/ retry. Used by both timeline and flat-grid fetch paths
// when the buckets or assets fetch throws / returns non-2xx. Retry bumps
// refreshKey, which is in the dependency list of both effects. Delegates to
// the shared ListErrorState card so every list surface fails identically.
function LibraryError({ onRetry }: { onRetry: () => void }) {
  return (
    <ListErrorState
      message="Couldn't load your library. Check your connection and retry."
      onRetry={onRetry}
    />
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
    <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)]">
      {pills.map((p) => (
        <button
          key={p.key}
          onClick={p.clear}
          className="inline-flex items-center gap-1 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] px-[var(--ft-space-3)] py-1 text-[var(--ft-color-on-secondary-container)] hover:brightness-95 transition-colors"
        >
          <span>{p.label}</span>
          <span aria-hidden className="text-base leading-none">×</span>
          <span className="sr-only">Remove filter</span>
        </button>
      ))}
      {pills.length > 1 && (
        <button
          onClick={() => toolbar.resetFilters()}
          className="ml-1 rounded-[var(--ft-shape-full)] px-[var(--ft-space-2)] py-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
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
    <div className="flex flex-wrap items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)]">
      {/* Lifecycle chips — Active / Archived / Trash. Mutually exclusive. */}
      <div className="flex items-center gap-1 rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] p-0.5">
        {LIFECYCLES.map((l) => {
          const active = filters.lifecycle === l.value;
          const Icon = l.icon;
          return (
            <button
              key={l.value}
              onClick={() => setFilters({ lifecycle: l.value })}
              className={`flex items-center gap-1 rounded-[var(--ft-shape-full)] px-[var(--ft-space-2)] py-1 transition-colors ${
                active
                  ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                  : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
              }`}
            >
              <Icon className="h-3 w-3" />
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Mime chips — All / Images / Videos / Documents. */}
      <div className="flex items-center gap-1 rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] p-0.5">
        {MIMES.map((m) => {
          const active = (filters.mime ?? null) === m.value;
          const Icon = m.icon;
          return (
            <button
              key={m.label}
              onClick={() => setFilters({ mime: m.value })}
              className={`flex items-center gap-1 rounded-[var(--ft-shape-full)] px-[var(--ft-space-2)] py-1 transition-colors ${
                active
                  ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                  : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          filters.favorite
            ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          filters.ratingMin != null
            ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
        className={`inline-flex h-8 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
          isActive
            ? "border-transparent text-white"
            : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] px-1">No groups yet.</p>
          )}
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                onChange(activeGroupId === g.id ? null : g.id);
                setOpen(false);
              }}
              className={`flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-extra-small)] px-[var(--ft-space-2)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-left text-[var(--ft-color-on-surface)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] ${
                activeGroupId === g.id ? "font-medium" : ""
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-[var(--ft-shape-full)] shrink-0"
                style={{ backgroundColor: g.color }}
              />
              {g.name}
              {activeGroupId === g.id && <span className="ml-auto text-[var(--ft-color-on-surface-variant)]">✓</span>}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] py-4">Loading…</div>}>
      <LibraryContent />
    </Suspense>
  );
}
