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
import { Loader2, Trash2, FolderTree, Image as ImageIcon, FileText, Film, Archive, Heart, Star, X, CalendarDays, Tag as TagIcon, FolderPlus, Download, Smartphone, LayoutGrid, Users, Palette, Upload, Pencil, FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { VirtualizedTimeline, type TimelineMonth } from "../_components/virtualized-timeline";
import {
  useToolbarState,
  type Lifecycle,
  type SortKey,
} from "@/lib/hooks/use-toolbar-state";
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
  deriveSplitState,
  kindForSelection,
  type LibrarySurface,
} from "../_components/library-surface-control";
import { LibraryFilesView } from "../_components/library-files-view";
import { FolderOpDialog, type FolderOpAction } from "../_components/folder-op-dialog";
import { GridSkeleton } from "../_components/grid-skeleton";
import { ListErrorState } from "../_components/list-states";

// Flat-grid (search / date-range / name·rating·largest sort) page size. The
// path is cursor-paged from here rather than fetching every matching row.
const FLAT_PAGE_SIZE = 200;

// Bulk endpoints cap at 1000 ids/request — chunk larger selections.
const BULK_CHUNK = 1000;

// Single source of truth for the `/api/v1/assets` (and `/assets/buckets`) query
// params. The buckets fetch, the per-month timeline windows, and the flat-grid
// pages all derive their filter params here so they can never drift on how a
// filter maps to a query key. `flat` adds the sort/date-range/free-text/limit
// that only the flat-grid + search path needs; the base shape (buckets + month
// windows) sets sort/window/limit itself. `kind` is the single lens param (M2
// lens reconciliation): it carries a single kind (`document`), a comma-union
// (`moment,video`), the Inbox sentinel (`unclassified` → `?unclassified=1`), or
// null/`all` (no kind filter). `splitOn` only picks the default lens.
function buildAssetListParams(input: {
  lifecycle: Lifecycle;
  kind: string | null;
  mime: string | null;
  subtype: string | null; // FilterState.type → `subtype` param
  favorite: boolean;
  ratingMin: number | null;
  directoryPath: string | null;
  directoryPathPrefix: string | null;
  groupId: string | null;
  placeFilter: string | null;
  splitOn: boolean;
  flat: boolean;
  // flat-only — omitted by the base (buckets/month) callers.
  sort?: SortKey;
  from?: string | null;
  to?: string | null;
  q?: string;
}): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set("lifecycle", input.lifecycle);
  if (input.kind === "unclassified") {
    // Inbox holding area — assets with no KIND yet. Sentinel, not a real kind.
    sp.set("unclassified", "1");
  } else {
    // Missing ?kind= defaults to Photos·All (moment,video) under the split, or
    // the "All" lens when flat — matches the mobile app's default view, which
    // shows photos + videos together; "all" clears the kind filter entirely.
    const lensKind = input.kind ?? (input.splitOn ? "moment,video" : "all");
    if (lensKind !== "all") sp.set("kind", lensKind);
  }
  if (input.mime) sp.set("mime", input.mime);
  if (input.subtype) sp.set("subtype", input.subtype);
  if (input.favorite) sp.set("favorite", "1");
  if (input.ratingMin != null) sp.set("ratingMin", String(input.ratingMin));
  if (input.directoryPath != null) sp.set("directoryPath", input.directoryPath);
  if (input.directoryPathPrefix != null) {
    sp.set("directoryPathPrefix", input.directoryPathPrefix);
  }
  if (input.groupId) sp.set("group_id", input.groupId);
  if (input.placeFilter) sp.set("place", input.placeFilter);
  if (!input.flat) return sp;
  // Flat-grid + search extras. Sort/date-range/free-text resolve server-side so
  // name/rating/largest and the date window are globally correct across the
  // whole result set. "newest"/"oldest" both use the captured axis (DESC);
  // "oldest" is a display-only reversal (applyClientTransforms) since the list
  // route exposes no ascending date axis.
  const sortAxis =
    input.sort === "name" || input.sort === "rating" || input.sort === "largest"
      ? input.sort
      : "captured";
  sp.set("sort", sortAxis);
  if (input.from) sp.set("dateFrom", input.from);
  if (input.to) sp.set("dateTo", input.to);
  if (input.q) sp.set("q", input.q);
  sp.set("limit", String(FLAT_PAGE_SIZE));
  return sp;
}

// The app shell scrolls its <main>, not the window. Lightbox scroll save +
// restore must target that element (window.scrollY/scrollTo are inert here).
function getLibraryScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector("main");
}

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
  // Timeline (buckets) and flat-grid errors are tracked separately so a failed
  // buckets fetch can never surface as — or tear down — the flat grid's state
  // (the two paths are mutually exclusive by `timelineMode`, but they shared one
  // error flag before, which flashed a stale error across a mode switch).
  const [bucketsError, setBucketsError] = useState(false);
  const [flatError, setFlatError] = useState(false);
  const [directAsset, setDirectAsset] = useState<Asset | null>(null);
  // `refreshKey` bumps remount/refetch after a mutation. Declared up here so
  // both the inbox-count effect and the batch handlers below can key on it.
  const [refreshKey, setRefreshKey] = useState(0);
  // Flat-grid pagination (P1 audit): the flat path is windowed + cursor-paged
  // instead of pulling every matching row in one unbounded response.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Opaque keyset cursor — self-describing (encodes the sort axis + position),
  // so paging works for every axis, incl. name/rating/largest where the list
  // route emits no legacy `nextCursor`. Echo it verbatim as ?cursor=.
  const flatCursorRef = useRef<string | null>(null);
  const flatRawRef = useRef<Asset[]>([]);
  // Bumped on every first-page (re)load so an in-flight loadMore from a prior
  // filter set can't commit its page onto the fresh accumulation.
  const flatGenRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
  // docs/claude/ui/photos-vs-files-split/plan.md.
  const flags = useFeatureFlags();
  const splitOn = flags.librarySurfaceSplit;
  // M2 lens reconciliation: `?kind=` is the single lens param. Derive the
  // control's (surface, lens) purely from it — no `?surface=`/`?lens=` params,
  // no first-paint localStorage hop.
  const { surface, lens: splitLens } = splitOn
    ? deriveSplitState(toolbar.filters.kind)
    : { surface: "photos" as LibrarySurface, lens: "all" };
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

  // Active lens — a missing ?kind= resolves to the default "All" lens
  // (mobile parity: the app's default view is photos + videos together).
  const activeLens = toolbar.filters.kind ?? "all";

  const [unsortedCount, setUnsortedCount] = useState(0);

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
    // The endpoint doesn't vary with `surface` — refetch only on mount and
    // after a mutation (refreshKey), not on every Photos↔Files toggle.
  }, [splitOn, refreshKey]);

  // Switching surface resets the lens to that surface's union (Photos·All →
  // moment,video, Files·All → screenshot,graphics,document, Inbox → sentinel)
  // and clears the free-text query on any move off Files (which owns search).
  const setSurface = useCallback(
    (s: LibrarySurface) => {
      toolbar.setFilters({
        kind: kindForSelection(s, "all"),
        ...(s !== "files" ? { q: "" } : {}),
      });
      trackLibrary("library_surface_toggle", { to: s });
    },
    [toolbar]
  );

  const setSplitLens = useCallback(
    (lens: string) => {
      toolbar.setFilters({ kind: kindForSelection(surface, lens) });
      trackLibrary("library_lens_select", { surface, lens });
    },
    [toolbar, surface]
  );

  // ADR 0008 Phase 5 — apply the saved default-scope preference on first paint
  // when no `?scope=` is in the URL. The selector chip strip takes over once
  // the user clicks; this hook only fires when the URL is unset.
  useSavedScopeDefault();

  // Server-side filter params shared by the buckets fetch and per-month
  // windowed fetch. Its identity changes whenever a filter changes, which is
  // exactly the signal VirtualizedTimeline uses to drop its per-month cache.
  const baseParams = useCallback(
    () =>
      buildAssetListParams({
        lifecycle: toolbar.filters.lifecycle,
        kind: toolbar.filters.kind,
        mime: toolbar.filters.mime,
        subtype: toolbar.filters.type,
        favorite: toolbar.filters.favorite,
        ratingMin: toolbar.filters.ratingMin,
        directoryPath: toolbar.filters.directoryPath,
        directoryPathPrefix: toolbar.filters.directoryPathPrefix,
        groupId: toolbar.filters.groupId,
        placeFilter,
        splitOn,
        flat: false,
      }),
    [
      splitOn,
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
    ]
  );

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
  useEffect(() => {
    fetch("/api/v1/collections")
      .then((r) => r.json() as Promise<{ collections?: { id: string; name: string }[] }>)
      .then((d) => setCollections(d.collections ?? []))
      .catch(() => undefined);
  }, []);

  const handleBatchAddToCollection = useCallback(
    async (collectionId: string) => {
      const ids = Array.from(toolbar.selectedIds);
      if (ids.length === 0) return;
      setShowCollectionModal(false);
      try {
        // One bulk request per ≤1000-id chunk instead of N parallel POSTs.
        // `added` counts newly-linked rows; already-linked are no-op no-counts.
        let added = 0;
        for (let i = 0; i < ids.length; i += BULK_CHUNK) {
          const assetIds = ids.slice(i, i + BULK_CHUNK);
          const r = await fetch(
            `/api/v1/collections/${collectionId}/assets/bulk`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ assetIds }),
            }
          );
          if (!r.ok) throw new Error(`add ${r.status}`);
          const d = (await r.json()) as { added: number };
          added += d.added;
        }
        toolbar.clearSelection();
        toolbar.setSelectMode(false);
        toast.add({ title: `Added ${added} to collection` });
      } catch {
        // Bulk is all-or-nothing per chunk — leave the selection intact so the
        // user can retry the whole set.
        toast.add({
          title: "Couldn't add to collection",
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
    if (ids.length === 0) return;
    try {
      // One bulk request per ≤1000-id chunk instead of N parallel PATCHes.
      let trashed = 0;
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        const batch = ids.slice(i, i + BULK_CHUNK);
        const r = await fetch("/api/v1/assets/bulk/trash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        });
        if (!r.ok) throw new Error(`trash ${r.status}`);
        const d = (await r.json()) as { trashed: number };
        trashed += d.trashed;
      }
      toolbar.clearSelection();
      toolbar.setSelectMode(false);
      toast.add({ title: `Moved ${trashed} to trash` });
      // Only bump the refresh when something actually moved, so the timeline
      // doesn't needlessly remount.
      if (trashed > 0) setRefreshKey((k) => k + 1);
    } catch {
      // Bulk is all-or-nothing per chunk — leave the selection intact for retry.
      toast.add({
        title: "Couldn't move to trash",
        description: "Left selected — try again.",
        priority: "high",
      });
    }
  }, [toolbar, toast]);

  // Per-card quick-action trash succeeded → drop the tile optimistically from
  // the flat grid's loaded set (the timeline path owns its own cache).
  const handleCardTrashed = useCallback((assetId: string) => {
    flatRawRef.current = flatRawRef.current.filter((a) => a.id !== assetId);
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
  }, []);

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
    setBucketsError(false);
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
          setBucketsError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBucketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [timelineMode, baseParams, refreshKey]);

  // Server-side query for one flat-grid page. Mirrors baseParams (incl.
  // group_id + place, which the fallback previously dropped) and adds the
  // capture-date sort + row cap the cursor pagination keys on.
  const flatParams = useCallback(
    () =>
      buildAssetListParams({
        lifecycle: toolbar.filters.lifecycle,
        kind: toolbar.filters.kind,
        mime: toolbar.filters.mime,
        subtype: toolbar.filters.type,
        favorite: toolbar.filters.favorite,
        ratingMin: toolbar.filters.ratingMin,
        directoryPath: toolbar.filters.directoryPath,
        directoryPathPrefix: toolbar.filters.directoryPathPrefix,
        groupId: toolbar.filters.groupId,
        placeFilter,
        splitOn,
        flat: true,
        sort: toolbar.filters.sort,
        from: toolbar.filters.from,
        to: toolbar.filters.to,
        q: toolbar.filters.q,
      }),
    [
      splitOn,
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
      toolbar.filters.sort,
      toolbar.filters.from,
      toolbar.filters.to,
      toolbar.filters.q,
    ]
  );

  // The list route now handles sort/date/free-text; the only transform left is
  // "oldest", a display reversal of the captured-DESC pages (no server-side
  // ascending date axis exists). Applied over the loaded-so-far set.
  const applyClientTransforms = useCallback(
    (rows: Asset[]): Asset[] =>
      toolbar.filters.sort === "oldest" ? [...rows].reverse() : rows,
    [toolbar.filters.sort]
  );

  // Flat-grid first-page fetch — runs when search / date-range / a client-side
  // sort forces the non-timeline surface. Bounded by FLAT_PAGE_SIZE + guarded
  // against stale-response races; further pages load on scroll via loadMore.
  useEffect(() => {
    if (timelineMode) return;
    // The Files surface owns its own fetch (LibraryFilesView). The flat grid
    // here serves the legacy view, the Inbox surface, and the search/date-range
    // fallback for Photos.
    if (splitOn && surface === "files") return;
    let cancelled = false;
    flatGenRef.current += 1;
    setLoading(true);
    setFlatError(false);
    flatCursorRef.current = null;
    flatRawRef.current = [];
    setHasMore(false);
    setLoadingMore(false);
    void (async () => {
      try {
        const r = await fetch(`/api/v1/assets?${flatParams().toString()}`);
        if (!r.ok) throw new Error(`assets ${r.status}`);
        const d = (await r.json()) as {
          assets?: Asset[];
          cursor?: string | null;
        };
        if (cancelled) return;
        flatRawRef.current = (d.assets ?? []) as Asset[];
        flatCursorRef.current = d.cursor ?? null;
        setHasMore(!!d.cursor);
        setAssets(applyClientTransforms(flatRawRef.current));
      } catch {
        if (cancelled) return;
        flatRawRef.current = [];
        setAssets([]);
        setFlatError(true);
        setHasMore(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    timelineMode,
    splitOn,
    surface,
    flatParams,
    applyClientTransforms,
    refreshKey,
  ]);

  // Fetch the next flat-grid page using the cursor the list route returns and
  // append it to the loaded set (re-running the client transforms over the
  // whole accumulation so an active sort stays consistent across pages).
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const cursor = flatCursorRef.current;
    if (!cursor) return;
    const gen = flatGenRef.current;
    setLoadingMore(true);
    try {
      const sp = flatParams();
      sp.set("cursor", cursor);
      const r = await fetch(`/api/v1/assets?${sp.toString()}`);
      if (!r.ok) throw new Error(`assets ${r.status}`);
      const d = (await r.json()) as {
        assets?: Asset[];
        cursor?: string | null;
      };
      // A first-page reload (filter change) happened while we were in flight —
      // drop this now-stale page rather than appending it to fresh data.
      if (gen !== flatGenRef.current) return;
      flatRawRef.current = [
        ...flatRawRef.current,
        ...((d.assets ?? []) as Asset[]),
      ];
      flatCursorRef.current = d.cursor ?? null;
      setHasMore(!!d.cursor);
      setAssets(applyClientTransforms(flatRawRef.current));
    } catch {
      if (gen === flatGenRef.current) setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, flatParams, applyClientTransforms]);

  // Auto-load the next page when the sentinel below the grid nears the viewport.
  useEffect(() => {
    if (timelineMode) return;
    if (splitOn && surface === "files") return;
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [timelineMode, splitOn, surface, hasMore, loadMore]);

  const openLightbox = useCallback((id: string, _index: number) => {
    // The app shell scrolls its <main>, not the window, so window.scrollY is
    // always ~0 here — capture the real scroller so restore lands the user
    // back where they were (esp. deep in a large virtualised grid).
    const scroller = getLibraryScroller();
    savedScrollRef.current = scroller ? scroller.scrollTop : window.scrollY;
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
        const scroller = getLibraryScroller();
        if (scroller) scroller.scrollTop = saved;
        else window.scrollTo({ top: saved, behavior: "instant" });
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
        {(() => {
          const activeFolder = toolbar.filters.directoryPath ?? toolbar.filters.directoryPathPrefix ?? null;
          if (!activeFolder) return null;
          return (
            <FolderBreadcrumb
              activePath={activeFolder}
              onChange={(path) =>
                toolbar.setFilters({ directoryPath: null, directoryPathPrefix: path })
              }
            />
          );
        })()}
        {/* Mobile uses the toolbar's Filter popover (lifecycle/mime/type/etc. all live there).
            Desktop keeps the inline chip strip for one-tap toggles. The chip
            strip is Photos-only under the split (Files has its own search). */}
        {photosActive && (
          <div className="hidden md:block">
            <LibraryChipStrip toolbar={toolbar} onCorpusChanged={() => setRefreshKey((k) => k + 1)} />
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
          kindParam={toolbar.filters.kind}
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
        ) : bucketsError ? (
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
      ) : flatError ? (
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
            onTrashed={handleCardTrashed}
          />
          {hasMore && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center gap-[var(--ft-space-2)] py-6 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]"
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              {loadingMore ? "Loading more…" : ""}
            </div>
          )}
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

function FolderBreadcrumb({
  activePath,
  onChange,
}: {
  activePath: string | null;
  onChange: (path: string | null) => void;
}) {
  if (!activePath) return null;
  const parts = activePath.split("/").filter(Boolean);
  return (
    <nav aria-label="Folder breadcrumb" className="flex items-center gap-1 overflow-x-auto text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
      <button
        onClick={() => onChange(null)}
        className="shrink-0 rounded px-1 py-0.5 hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
      >
        /
      </button>
      {parts.map((part, i) => {
        const target = `/${parts.slice(0, i + 1).join("/")}`;
        const isLast = i === parts.length - 1;
        return (
          <span key={target} className="flex items-center gap-1 shrink-0">
            <span className="text-[var(--ft-color-outline)]">›</span>
            <button
              onClick={() => onChange(target)}
              className={`rounded px-1 py-0.5 ${isLast ? "font-medium text-[var(--ft-color-on-surface)]" : "hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"}`}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

// Last path segment — the folder's display name for the op dialog.
function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function FolderChip({
  activePath,
  onChange,
  onChanged,
}: {
  activePath: string | null;
  onChange: (path: string | null) => void;
  // Fired after a folder op (rename/move/delete) or an asset drop mutates the
  // corpus, so the parent can refetch the grid/timeline.
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [opDialog, setOpDialog] = useState<{
    action: FolderOpAction;
    folder: { name: string; path: string };
  } | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const toast = useSnackbar();
  const active = activePath != null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show folder spinner when picker opens before fetch
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
  }, [open, reloadTick]);

  // Folder rename/move/delete → POST /api/v1/folders/operation (folders are
  // directory_path prefixes; the server bulk-updates matching assets). Returns
  // an error string for the dialog, or null on success.
  const performFolderOp = useCallback(
    async (payload: Record<string, unknown>): Promise<string | null> => {
      try {
        const r = await fetch("/api/v1/folders/operation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return `Folder op failed: ${body.error ?? r.status}`;
        }
        setReloadTick((t) => t + 1);
        onChanged?.();
        return null;
      } catch {
        return "Network error — check your connection and retry.";
      }
    },
    [onChanged]
  );

  // Drag-drop asset → folder: PATCH the asset's directoryPath. NOTE this only
  // fires while the popover is open (it is the drop surface); the reliable path
  // for a closed picker is to open a folder then move via the op dialog.
  const handleAssetDrop = useCallback(
    async (folderPath: string, assetId: string) => {
      try {
        const r = await fetch(`/api/v1/assets/${assetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directoryPath: folderPath }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          toast.add({ title: "Move failed", description: String(body.error ?? r.status), priority: "high" });
          return;
        }
        setReloadTick((t) => t + 1);
        onChanged?.();
      } catch {
        toast.add({ title: "Move failed", description: "Network error.", priority: "high" });
      }
    },
    [toast, onChanged]
  );

  return (
    <>
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
        <PopoverContent className="w-80 max-h-72 overflow-y-auto" align="start" sideOffset={6}>
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
              {folders.map((f) => {
                const isDropTarget = dragOverPath === f.path;
                return (
                  <div
                    key={f.path}
                    className={`group flex items-center gap-1 rounded-[var(--ft-shape-extra-small)] transition-colors ${
                      isDropTarget ? "ring-1 ring-[var(--ft-color-primary)] bg-[color-mix(in_srgb,var(--ft-color-primary)_10%,transparent)]" : ""
                    }`}
                    onDragOver={(e) => {
                      // Only accept an asset drag; keep the popover's drop surface live.
                      if (e.dataTransfer.types.includes("application/x-fonto-asset")) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverPath !== f.path) setDragOverPath(f.path);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverPath === f.path) setDragOverPath(null);
                    }}
                    onDrop={(e) => {
                      const assetId = e.dataTransfer.getData("application/x-fonto-asset");
                      setDragOverPath(null);
                      if (assetId) {
                        e.preventDefault();
                        void handleAssetDrop(f.path, assetId);
                      }
                    }}
                  >
                    <button
                      onClick={() => {
                        onChange(f.path);
                        setOpen(false);
                      }}
                      className={`min-w-0 flex-1 truncate rounded-[var(--ft-shape-extra-small)] px-[var(--ft-space-2)] py-1 text-left text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] transition-colors ${
                        activePath === f.path
                          ? "bg-[var(--ft-color-secondary-container)] font-medium text-[var(--ft-color-on-secondary-container)]"
                          : "text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
                      }`}
                    >
                      {f.path}
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {([
                        { action: "rename" as const, Icon: Pencil, label: "Rename folder" },
                        { action: "move" as const, Icon: FolderInput, label: "Move folder" },
                        { action: "delete" as const, Icon: Trash2, label: "Delete folder" },
                      ]).map(({ action, Icon, label }) => (
                        <button
                          key={action}
                          aria-label={label}
                          title={label}
                          onClick={() => setOpDialog({ action, folder: { name: folderName(f.path), path: f.path } })}
                          className="rounded-[var(--ft-shape-extra-small)] p-1 text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {opDialog && (
        <FolderOpDialog
          op={opDialog}
          onClose={() => setOpDialog(null)}
          onSubmit={(payload) => performFolderOp(payload)}
        />
      )}
    </>
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
      role="group"
      aria-label="Library lens"
    >
      {LENSES.map((lens) => {
        const isActive = active === lens.value;
        const Icon = lens.icon;
        return (
          <button
            key={lens.value}
            type="button"
            aria-pressed={isActive}
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
  onCorpusChanged,
}: {
  toolbar: ReturnType<typeof useToolbarState>;
  onCorpusChanged?: () => void;
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
        onChanged={onCorpusChanged}
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
