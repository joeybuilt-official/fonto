// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — shared sticky toolbar for every asset-bearing page.
//
// Per docs/ux-asset-page-audit-2026-05.md §1 the contract is:
//   [title + count] [search] [sort] [filter] [ai-ask]
//                   [view-mode] [density] [select] [page-action]
//
// Pages do NOT instantiate the slots themselves — they pass a single
// ToolbarStateAPI (from useToolbarState) plus opt-in flags for the
// slots they want exposed. Anything not opted in is hidden, so the
// toolbar layout is identical even on slim pages like /trash.
//
// Search is debounced internally (250ms) — the parent gets one onChange
// per pause, not one per keystroke. Local input value mirrors the
// committed `q` so the input stays controlled across back/forward.

"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Check,
  Grid3x3,
  LayoutGrid,
  List,
  Map as MapIcon,
  Calendar,
  MousePointer2,
  Search,
  Sparkles,
  X,
  Rows3,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  FilterPopover,
  type FilterKey,
} from "./filter-popover";
import type {
  SortKey,
  ToolbarStateAPI,
  ViewMode,
} from "@/lib/hooks/use-toolbar-state";

const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest",
  oldest: "Oldest",
  largest: "Largest",
  name: "Name (A→Z)",
  rating: "Highest rated",
};

const VIEW_MODE_META: Record<ViewMode, { label: string; icon: React.ReactNode }> = {
  grid: { label: "Grid", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
  list: { label: "List", icon: <List className="h-3.5 w-3.5" /> },
  map: { label: "Map", icon: <MapIcon className="h-3.5 w-3.5" /> },
  timeline: { label: "Timeline", icon: <Calendar className="h-3.5 w-3.5" /> },
};

export interface AssetPageToolbarProps {
  title: string;
  /** Total count of items in the current result set (after filters). */
  count?: number;
  /** Hooked ToolbarStateAPI from useToolbarState. */
  toolbar: ToolbarStateAPI;

  /** Which slots to show; null/omitted = hidden. */
  searchPlaceholder?: string;
  sortOptions?: SortKey[];
  filterKeys?: FilterKey[];
  viewModes?: ViewMode[];
  showDensity?: boolean;
  showSelect?: boolean;

  /** Sparkles button — opens the AI ask rail. Receives the current selection,
   *  or the full visible result set if nothing's selected. Toolbar doesn't
   *  know the visible IDs, so the host page passes them via getContextIds. */
  onAskAI?: (contextIds: string[]) => void;
  getAskContextIds?: () => string[];

  /** Page-specific primary action (e.g. "Upload", "New collection"). */
  primaryAction?: {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    variant?: "default" | "outline" | "secondary";
  };
}

export function AssetPageToolbar({
  title,
  count,
  toolbar,
  searchPlaceholder = "Search…",
  sortOptions,
  filterKeys,
  viewModes,
  showDensity = true,
  showSelect = true,
  onAskAI,
  getAskContextIds,
  primaryAction,
}: AssetPageToolbarProps) {
  const { filters, view, selectMode, setFilters, setView, setSelectMode } =
    toolbar;

  // Local mirror of `q` so typing stays smooth even though URL writes are
  // debounced — without this every keystroke would either commit to URL
  // (laggy) or fight the controlled value (caret jump).
  const [q, setQ] = useState(filters.q);
  useEffect(() => {
    // Sync from URL when the toolbar's `q` changes outside the input (back
    // button, reset, deep link). Skip if we're the source of truth already.
    setQ(filters.q);
  }, [filters.q]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (q === filters.q) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilters({ q }), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // setFilters identity is stable via useCallback in the hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="flex flex-wrap items-center gap-2">
        {/* Slot 1: title + count */}
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate font-heading text-base font-semibold text-foreground">
            {title}
          </h1>
          {count != null && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {count.toLocaleString()}
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* Slot 2: search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-7 w-48 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          {/* Slot 3: sort */}
          {sortOptions && sortOptions.length > 0 && (
            <SortMenu
              value={filters.sort}
              options={sortOptions}
              onChange={(s) => setFilters({ sort: s })}
            />
          )}

          {/* Slot 4: filter */}
          {filterKeys && filterKeys.length > 0 && (
            <FilterPopover
              state={filters}
              available={filterKeys}
              onChange={(patch) => setFilters(patch)}
              onReset={() => toolbar.resetFilters()}
            />
          )}

          {/* Slot 5: AI ask */}
          {onAskAI && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onAskAI(getAskContextIds ? getAskContextIds() : [])
              }
              aria-label="Ask AI about this view"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span>Ask</span>
            </Button>
          )}

          {/* Slot 6: view mode */}
          {viewModes && viewModes.length > 1 && (
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {viewModes.map((m) => {
                const active = view.viewMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setView({ viewMode: m })}
                    title={VIEW_MODE_META[m].label}
                    className={cn(
                      "flex h-7 items-center justify-center px-2 text-xs transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted/60"
                    )}
                    aria-pressed={active}
                  >
                    {VIEW_MODE_META[m].icon}
                  </button>
                );
              })}
            </div>
          )}

          {/* Slot 7: density */}
          {showDensity && (
            <DensityMenu
              value={view.density}
              onChange={(d) => setView({ density: d })}
            />
          )}

          {/* Slot 8: select mode */}
          {showSelect && (
            <Button
              variant={selectMode ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectMode(!selectMode)}
            >
              {selectMode ? (
                <>
                  <X className="h-3.5 w-3.5" />
                  <span>Done</span>
                </>
              ) : (
                <>
                  <MousePointer2 className="h-3.5 w-3.5" />
                  <span>Select</span>
                </>
              )}
            </Button>
          )}

          {/* Slot 9: page action */}
          {primaryAction && (
            <Button
              variant={primaryAction.variant ?? "default"}
              size="sm"
              onClick={primaryAction.onClick}
            >
              {primaryAction.icon}
              <span>{primaryAction.label}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SortMenu({
  value,
  options,
  onChange,
}: {
  value: SortKey;
  options: SortKey[];
  onChange: (v: SortKey) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
        <span>{SORT_LABELS[value]}</span>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end" sideOffset={6}>
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={cn(
              "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted",
              value === o && "bg-muted font-medium"
            )}
          >
            <span>{SORT_LABELS[o]}</span>
            {value === o && <Check className="h-3 w-3" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const DENSITY_META: Record<"comfortable" | "compact" | "dense", { label: string; icon: React.ReactNode }> = {
  comfortable: { label: "Comfortable", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
  compact: { label: "Compact", icon: <Grid3x3 className="h-3.5 w-3.5" /> },
  dense: { label: "Dense", icon: <Rows3 className="h-3.5 w-3.5" /> },
};

function DensityMenu({
  value,
  onChange,
}: {
  value: "comfortable" | "compact" | "dense";
  onChange: (v: "comfortable" | "compact" | "dense") => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={buttonVariants({ variant: "outline", size: "icon-sm" })}
        title={`Density: ${DENSITY_META[value].label}`}
        aria-label="Change grid density"
      >
        {DENSITY_META[value].icon}
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end" sideOffset={6}>
        {(Object.keys(DENSITY_META) as Array<keyof typeof DENSITY_META>).map(
          (d) => (
            <button
              key={d}
              onClick={() => onChange(d)}
              className={cn(
                "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted",
                value === d && "bg-muted font-medium"
              )}
            >
              <span className="flex items-center gap-2">
                {DENSITY_META[d].icon}
                {DENSITY_META[d].label}
              </span>
              {value === d && <Check className="h-3 w-3" />}
            </button>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
