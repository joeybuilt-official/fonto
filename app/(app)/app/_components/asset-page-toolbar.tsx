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

// Map the legacy primaryAction.variant API ("default" | "outline" | "secondary")
// onto MD3 button variants. Keeps host pages backwards-compatible while the
// toolbar internals consume the new namespace.
function mapPrimaryVariant(
  v?:
    | "default"
    | "outline"
    | "secondary"
    | "filled"
    | "tonal"
    | "outlined"
    | "text"
    | "elevated"
): "filled" | "outlined" | "tonal" | "text" | "elevated" {
  if (v === "outline") return "outlined";
  if (v === "secondary") return "tonal";
  if (v === "filled" || v === "tonal" || v === "outlined" || v === "text" || v === "elevated") return v;
  return "filled";
}

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
    /** Accepts both the legacy shadcn variants (`default`, `outline`,
     *  `secondary`) and the MD3 set (`filled`, `tonal`, `outlined`, `text`,
     *  `elevated`). Forwarded verbatim to `<Button variant={...}>`. */
    variant?:
      | "default"
      | "outline"
      | "secondary"
      | "filled"
      | "tonal"
      | "outlined"
      | "text"
      | "elevated";
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
  // debounced. The input is the source of truth while the user is typing;
  // we only sync back FROM the URL when the input is unfocused (e.g. back
  // button after the user has tabbed away). The old "always sync on
  // filters.q change" pattern fought the typist — a debounced setFilters
  // round-trip 250ms later overwrote characters typed during that window,
  // producing dropped/reordered letters.
  const [q, setQ] = useState(filters.q);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) return;
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
    // setFilters identity is stable via useCallback in the hook; depending
    // on it would re-arm the debounce on every render and re-introduce the
    // letter-dropping bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="sticky top-0 z-20 flex flex-col gap-[var(--ft-space-2)] border-b border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)]/95 px-[var(--ft-space-4)] py-[var(--ft-space-3)] backdrop-blur supports-[backdrop-filter]:bg-[var(--ft-color-surface)]/75">
      <div className="flex flex-wrap items-center gap-[var(--ft-space-2)]">
        {/* Slot 1: title + count */}
        <div className="flex min-w-0 items-baseline gap-[var(--ft-space-2)]">
          <h1 className="truncate font-heading text-[length:var(--ft-type-title-large-size)] leading-[var(--ft-type-title-large-line)] font-semibold text-[var(--ft-color-on-surface)]">
            {title}
          </h1>
          {count != null && (
            <span className="shrink-0 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] tabular-nums text-[var(--ft-color-on-surface-variant)]">
              {count.toLocaleString()}
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* Slot 2: search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ft-color-on-surface-variant)]" />
            <input
              ref={inputRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 w-48 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent pl-7 pr-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] placeholder:text-[var(--ft-color-on-surface-variant)] focus:border-[var(--ft-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
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
              variant="text"
              size="sm"
              onClick={() =>
                onAskAI(getAskContextIds ? getAskContextIds() : [])
              }
              aria-label="Ask AI about this view"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Ask</span>
            </Button>
          )}

          {/* Slot 6: view mode */}
          {viewModes && viewModes.length > 1 && (
            <div className="inline-flex overflow-hidden rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)]">
              {viewModes.map((m) => {
                const active = view.viewMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setView({ viewMode: m })}
                    title={VIEW_MODE_META[m].label}
                    className={cn(
                      "flex h-8 items-center justify-center px-[var(--ft-space-2)] text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] transition-colors",
                      active
                        ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                        : "bg-transparent text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]"
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
              variant={selectMode ? "tonal" : "text"}
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
              variant={mapPrimaryVariant(primaryAction.variant)}
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
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={buttonVariants({ variant: "outlined", size: "sm" })}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
        <span>{SORT_LABELS[value]}</span>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end" sideOffset={6}>
        {options.map((o) => (
          <Button
            key={o}
            variant="text"
            size="sm"
            onClick={() => {
              onChange(o);
              setOpen(false);
            }}
            className={cn(
              "w-full justify-between !rounded-[var(--ft-shape-small)]",
              value === o && "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            )}
          >
            <span>{SORT_LABELS[o]}</span>
            {value === o && <Check className="h-3 w-3" />}
          </Button>
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
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={buttonVariants({ variant: "outlined", size: "icon-sm" })}
        title={`Density: ${DENSITY_META[value].label}`}
        aria-label="Change grid density"
      >
        {DENSITY_META[value].icon}
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end" sideOffset={6}>
        {(Object.keys(DENSITY_META) as Array<keyof typeof DENSITY_META>).map(
          (d) => (
            <Button
              key={d}
              variant="text"
              size="sm"
              onClick={() => {
                onChange(d);
                setOpen(false);
              }}
              className={cn(
                "w-full justify-between !rounded-[var(--ft-shape-small)]",
                value === d && "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
              )}
            >
              <span className="flex items-center gap-[var(--ft-space-2)]">
                {DENSITY_META[d].icon}
                {DENSITY_META[d].label}
              </span>
              {value === d && <Check className="h-3 w-3" />}
            </Button>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
