// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — single source of truth for AssetPageToolbar state.
//
// Splits state into three layers, each with the right persistence:
//
//   1. Filter + query state (URL):    q, sort, type, from, to, color, fav,
//                                     rating, mime, person, tag — deep-linkable
//                                     and back/forward-correct.
//   2. View state (localStorage):     density, viewMode — user preference,
//                                     persisted per page key.
//   3. Ephemeral state (component):   selectMode, selectedIds — never persisted.
//
// Pages call useToolbarState({ page: "photos", availableFilters: [...] }) and
// get back a `{ state, set, reset }` triple that the toolbar binds straight to.

"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type SortKey =
  | "newest"
  | "oldest"
  | "largest"
  | "name"
  | "rating";

export type ViewMode = "grid" | "list" | "map" | "timeline";

export type Density = "comfortable" | "compact" | "dense";

export type Lifecycle = "active" | "archived" | "trashed";

export interface FilterState {
  q: string;
  sort: SortKey;
  type: string | null;          // classification (photo/screenshot/etc.) or top-level mime prefix
  mime: string | null;          // explicit mime filter — distinct from `type` (subtype)
  // Task 20 — library lens (KIND). null = no lens filter ("All"); otherwise
  // one of moment|screenshot|document|video. The library page treats a
  // missing value as the default "Moments" lens.
  kind: string | null;
  from: string | null;          // ISO date (yyyy-mm-dd)
  to: string | null;
  color: string | null;         // dominant color name or hex
  favorite: boolean;
  ratingMin: number | null;     // 1..5
  personIds: string[];
  tagIds: string[];
  groupId: string | null;   // person-group filter (Family / Friends / …)
  // Phase 1 (UX consolidation) ��� replaces the dedicated Trash route.
  // 'active' (default), 'archived', 'trashed' map 1:1 to assets.lifecycle_state.
  lifecycle: Lifecycle;
  // Phase 1 (UX consolidation) — replaces the dedicated Folders route.
  // null = no folder filter; "" / "/" = root level; otherwise an exact
  // path. Pair with `directoryPathPrefix` for recursive scope.
  directoryPath: string | null;
  directoryPathPrefix: string | null;
  // EXIF facets. Free-text camera/lens (contains-match server-side); iso /
  // fNumber / focalLength carried as strings, parsed + exact-matched by the
  // shared exifFilterConditions() helper. Surfaced only where a page lists
  // them in availableFilters (today: search).
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: string | null;
  fNumber: string | null;
  focalLength: string | null;
}

export interface ViewState {
  density: Density;
  viewMode: ViewMode;
}

const DEFAULT_FILTERS: FilterState = {
  q: "",
  sort: "newest",
  type: null,
  mime: null,
  kind: null,
  from: null,
  to: null,
  color: null,
  favorite: false,
  ratingMin: null,
  personIds: [],
  tagIds: [],
  groupId: null,
  lifecycle: "active",
  directoryPath: null,
  directoryPathPrefix: null,
  cameraMake: null,
  cameraModel: null,
  lensModel: null,
  iso: null,
  fNumber: null,
  focalLength: null,
};

const DEFAULT_VIEW: ViewState = {
  density: "comfortable",
  viewMode: "grid",
};

// ---- URL serialisation ----------------------------------------------------

function readFilters(sp: URLSearchParams): FilterState {
  const list = (k: string): string[] => {
    const raw = sp.get(k);
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  };
  const ratingRaw = sp.get("rating");
  const ratingParsed = ratingRaw == null ? NaN : Number.parseInt(ratingRaw, 10);
  const lcRaw = sp.get("lc");
  const lifecycle: Lifecycle =
    lcRaw === "archived" || lcRaw === "trashed" ? lcRaw : "active";
  return {
    q: sp.get("q") ?? "",
    sort: (sp.get("sort") as SortKey) || "newest",
    type: sp.get("type"),
    mime: sp.get("mime"),
    kind: sp.get("kind"),
    from: sp.get("from"),
    to: sp.get("to"),
    color: sp.get("color"),
    favorite: sp.get("fav") === "1",
    ratingMin:
      Number.isInteger(ratingParsed) && ratingParsed >= 1 && ratingParsed <= 5
        ? ratingParsed
        : null,
    personIds: list("person"),
    tagIds: list("tag"),
    groupId: sp.get("groupId"),
    lifecycle,
    directoryPath: sp.get("path"),
    directoryPathPrefix: sp.get("pathPrefix"),
    cameraMake: sp.get("cameraMake"),
    cameraModel: sp.get("cameraModel"),
    lensModel: sp.get("lensModel"),
    iso: sp.get("iso"),
    fNumber: sp.get("fNumber"),
    focalLength: sp.get("focalLength"),
  };
}

function writeFilters(base: URLSearchParams, f: FilterState): URLSearchParams {
  const sp = new URLSearchParams(base.toString());
  const setOrDel = (k: string, v: string | null | undefined) => {
    if (v == null || v === "") sp.delete(k);
    else sp.set(k, v);
  };
  setOrDel("q", f.q);
  setOrDel("sort", f.sort === "newest" ? null : f.sort);
  setOrDel("type", f.type);
  setOrDel("mime", f.mime);
  setOrDel("kind", f.kind);
  setOrDel("from", f.from);
  setOrDel("to", f.to);
  setOrDel("color", f.color);
  setOrDel("fav", f.favorite ? "1" : null);
  setOrDel("rating", f.ratingMin != null ? String(f.ratingMin) : null);
  setOrDel("person", f.personIds.length ? f.personIds.join(",") : null);
  setOrDel("tag", f.tagIds.length ? f.tagIds.join(",") : null);
  setOrDel("groupId", f.groupId);
  setOrDel("lc", f.lifecycle === "active" ? null : f.lifecycle);
  setOrDel("path", f.directoryPath);
  setOrDel("pathPrefix", f.directoryPathPrefix);
  setOrDel("cameraMake", f.cameraMake);
  setOrDel("cameraModel", f.cameraModel);
  setOrDel("lensModel", f.lensModel);
  setOrDel("iso", f.iso);
  setOrDel("fNumber", f.fNumber);
  setOrDel("focalLength", f.focalLength);
  return sp;
}

// ---- localStorage layer (view prefs) --------------------------------------

function storageKey(page: string): string {
  return `fonto:toolbar:${page}`;
}

function loadView(page: string): ViewState {
  if (typeof window === "undefined") return DEFAULT_VIEW;
  try {
    const raw = window.localStorage.getItem(storageKey(page));
    if (!raw) return DEFAULT_VIEW;
    const parsed = JSON.parse(raw) as Partial<ViewState>;
    return {
      density:
        parsed.density === "compact" || parsed.density === "dense"
          ? parsed.density
          : "comfortable",
      viewMode:
        parsed.viewMode === "list" ||
        parsed.viewMode === "map" ||
        parsed.viewMode === "timeline"
          ? parsed.viewMode
          : "grid",
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

// Per-page snapshot cache. Required because useSyncExternalStore calls the
// snapshot getter on every render and compares with Object.is — a fresh
// object literal each call triggers an infinite re-render loop. The cache
// holds the last-read value per page key; persistView invalidates it so the
// next read sees the new value.
const viewSnapshotCache = new Map<string, ViewState>();

function readViewSnapshot(page: string, defaults: ViewState): ViewState {
  const cached = viewSnapshotCache.get(page);
  if (cached) return cached;
  const fresh = { ...defaults, ...loadView(page) };
  viewSnapshotCache.set(page, fresh);
  return fresh;
}

function persistView(page: string, view: ViewState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(page), JSON.stringify(view));
    viewSnapshotCache.delete(page);
    // Notify same-tab subscribers — the native `storage` event only fires
    // cross-tab. Custom event keeps the useSyncExternalStore subscription
    // alive when the toolbar is the writer.
    window.dispatchEvent(new CustomEvent("fonto:toolbar:view-changed"));
  } catch {
    // Quota exceeded / Safari private mode — silently drop.
  }
}

function subscribeToView(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  // Cross-tab `storage` event landed: assume any toolbar key may have
  // changed and invalidate the whole cache so the next snapshot re-reads.
  const onStorage = () => {
    viewSnapshotCache.clear();
    callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("fonto:toolbar:view-changed", callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("fonto:toolbar:view-changed", callback);
  };
}

// ---- public hook ----------------------------------------------------------

export interface UseToolbarStateOptions {
  /** Stable page identifier — drives localStorage key. e.g. "photos", "documents". */
  page: string;
  /** Which filter keys this page actually exposes. Used by FilterPopover; the
   *  hook itself keeps the full FilterState so URL params for filters the page
   *  doesn't expose are preserved on round-trips. */
  availableFilters?: Array<keyof FilterState>;
  /** Optional default overrides — e.g. trash page wants `sort=oldest`. */
  defaults?: Partial<FilterState & ViewState>;
}

export interface ToolbarStateAPI {
  filters: FilterState;
  view: ViewState;
  selectMode: boolean;
  selectedIds: Set<string>;
  availableFilters: Array<keyof FilterState>;

  setFilters: (patch: Partial<FilterState>) => void;
  setView: (patch: Partial<ViewState>) => void;
  setSelectMode: (v: boolean) => void;
  toggleSelect: (id: string) => void;
  selectRange: (allIds: string[], anchorId: string, targetId: string) => void;
  clearSelection: () => void;
  resetFilters: () => void;
}

export function useToolbarState(
  options: UseToolbarStateOptions
): ToolbarStateAPI {
  const { page, availableFilters = [], defaults = {} } = options;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Filters come from the URL on every render so back/forward works without
  // a refresh. The merge with `defaults` only applies when the URL slot is
  // empty — explicit user choices always win.
  const filters = useMemo<FilterState>(() => {
    const parsed = readFilters(searchParams);
    const merged: FilterState = { ...DEFAULT_FILTERS, ...defaults, ...parsed };
    // `parsed` overrides defaults but only for keys present in the URL —
    // readFilters returns "" / null for missing keys, which would clobber a
    // non-empty default. Re-apply defaults where parsed is falsy.
    for (const [k, v] of Object.entries(defaults)) {
      const key = k as keyof FilterState;
      // Only fields, not view keys
      if (!(key in DEFAULT_FILTERS)) continue;
      const cur = merged[key] as unknown;
      if (cur === "" || cur == null || (Array.isArray(cur) && cur.length === 0)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (merged as any)[key] = v;
      }
    }
    return merged;
  }, [searchParams, defaults]);

  // View state is purely client and persisted to localStorage. Use
  // useSyncExternalStore so the first client render lines up with the
  // persisted value (no setState-in-effect flash) and SSR returns the
  // SSR-safe default; the server snapshot is the un-merged DEFAULT_VIEW
  // so hydration matches.
  const viewDefaults = useMemo<ViewState>(
    () => ({
      ...DEFAULT_VIEW,
      ...(defaults.density ? { density: defaults.density } : {}),
      ...(defaults.viewMode ? { viewMode: defaults.viewMode } : {}),
    }),
    [defaults.density, defaults.viewMode]
  );
  const getViewSnapshot = useCallback(
    () => readViewSnapshot(page, viewDefaults),
    [page, viewDefaults]
  );
  const getServerSnapshot = useCallback(() => viewDefaults, [viewDefaults]);
  const view = useSyncExternalStore(
    subscribeToView,
    getViewSnapshot,
    getServerSnapshot
  );

  // Selection lives in component state — ephemeral, never persisted, cleared
  // when the user leaves select mode.
  const [selectMode, setSelectModeState] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const setFilters = useCallback(
    (patch: Partial<FilterState>) => {
      const next = { ...filters, ...patch };
      const sp = writeFilters(searchParams, next);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, searchParams, router, pathname]
  );

  const setView = useCallback(
    (patch: Partial<ViewState>) => {
      // Read the current persisted value rather than racing a snapshot —
      // localStorage is the source of truth, useSyncExternalStore re-pulls
      // on the dispatched event.
      const current = { ...viewDefaults, ...loadView(page) };
      persistView(page, { ...current, ...patch });
    },
    [page, viewDefaults]
  );

  const setSelectMode = useCallback((v: boolean) => {
    setSelectModeState(v);
    if (!v) setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Shift-click range select. Caller passes the current ordered id list (the
  // toolbar doesn't know it) plus the anchor and target. Range is inclusive.
  const selectRange = useCallback(
    (allIds: string[], anchorId: string, targetId: string) => {
      const a = allIds.indexOf(anchorId);
      const b = allIds.indexOf(targetId);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(allIds[i]);
        return next;
      });
    },
    []
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const resetFilters = useCallback(() => {
    const sp = new URLSearchParams(searchParams.toString());
    // Drop every key the toolbar manages; preserve unrelated params (e.g. a
    // page's own ?folder= parameter).
    for (const k of ["q", "sort", "type", "mime", "kind", "from", "to", "color", "fav", "rating", "person", "tag", "lc", "path", "pathPrefix"]) {
      sp.delete(k);
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, router, pathname]);

  return {
    filters,
    view,
    selectMode,
    selectedIds,
    availableFilters,
    setFilters,
    setView,
    setSelectMode,
    toggleSelect,
    selectRange,
    clearSelection,
    resetFilters,
  };
}
