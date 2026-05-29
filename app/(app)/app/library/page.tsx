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
import { Loader2, Trash2, FolderTree, Image as ImageIcon, FileText, Film, Archive, Heart, Star, X, CalendarDays, Tag as TagIcon } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { VirtualizedTimeline, type TimelineMonth } from "../_components/virtualized-timeline";
import { useToolbarState, type Lifecycle } from "@/lib/hooks/use-toolbar-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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
      "favorite",
      "ratingMin",
      "lifecycle",
      "directoryPath",
      "directoryPathPrefix",
      "from",
      "to",
    ],
  });

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [buckets, setBuckets] = useState<TimelineMonth[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(true);
  const [directAsset, setDirectAsset] = useState<Asset | null>(null);
  const savedScrollRef = useRef(0);
  const prevLbIndexRef = useRef<number | null>(null);

  // The dated timeline is the default browse surface. Free-text search and
  // explicit date-range bounds can't be expressed by the month-bucket
  // scrubber / per-month windowed fetch, so those two fall back to the flat
  // chronological grid (which loads the whole filtered set + filters
  // client-side). Every other chip (lifecycle / mime / type / favorite /
  // rating / folder) maps to server-side params the timeline + buckets
  // endpoints both honour, so the scrubber stays exact under them.
  const timelineMode =
    !toolbar.filters.q && !toolbar.filters.from && !toolbar.filters.to;

  // Server-side filter params shared by the buckets fetch and per-month
  // windowed fetch. Its identity changes whenever a filter changes, which is
  // exactly the signal VirtualizedTimeline uses to drop its per-month cache.
  const baseParams = useCallback(() => {
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
    return sp;
  }, [
    toolbar.filters.lifecycle,
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.directoryPath,
    toolbar.filters.directoryPathPrefix,
  ]);

  // Load exactly one month's assets (captured-date order). Pages within the
  // [firstOfThisMonth, firstOfNextMonth) window until the boundary is crossed
  // so post-fetch mime/subtype filtering in the list route can't truncate the
  // month. Stable per filter set (depends on baseParams).
  const fetchMonth = useCallback(
    async (month: string): Promise<Asset[]> => {
      const [y, m] = month.split("-").map(Number);
      const firstOfThis = Date.UTC(y, m - 1, 1);
      const firstOfNext = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
      const base = baseParams();
      base.set("sort", "captured");
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
    fetch(`/api/v1/assets/buckets?${baseParams().toString()}`)
      .then((r) => r.json() as Promise<{ buckets?: TimelineMonth[] }>)
      .then((d) => {
        if (!cancelled) setBuckets(d.buckets ?? []);
      })
      .catch(() => {
        if (!cancelled) setBuckets([]);
      })
      .finally(() => {
        if (!cancelled) setBucketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [timelineMode, baseParams]);

  // Flat-grid fallback fetch — only runs when search / date-range force the
  // non-timeline surface. Loads the whole filtered set + filters client-side.
  useEffect(() => {
    if (timelineMode) return;
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
    timelineMode,
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
      <AssetPageToolbar
        title="Library"
        count={timelineTotal}
        toolbar={toolbar}
        searchPlaceholder="Search library…"
        sortOptions={["newest", "oldest", "name", "rating", "largest"]}
        filterKeys={["type", "mime", "from", "to", "directoryPathPrefix", "favorite", "ratingMin"]}
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

      {timelineMode ? (
        bucketsLoading && buckets.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : buckets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <ImageIcon className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No assets match the current filters.
            </p>
          </div>
        ) : (
          <div className="px-4">
            <VirtualizedTimeline
              buckets={buckets}
              fetchMonth={fetchMonth}
              onAssetClick={(a) => openLightbox(a.id, 0)}
              onLoadedAssetsChange={handleLoadedAssets}
            />
          </div>
        )
      ) : loading ? (
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
