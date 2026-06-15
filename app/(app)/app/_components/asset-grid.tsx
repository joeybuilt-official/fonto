// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — shared asset grid primitive. Wraps PhotoCard.
//
// Responsibilities:
//   - Density-aware column count (comfortable / compact / dense).
//   - viewMode = "grid" (square tile grid) or "list" (rows + thumb + meta).
//   - Selection wiring with shift-click range select against the visible
//     order — replaces the bespoke implementation in photos/page.tsx:190-213.
//   - Batch thumb URL fetch via POST /api/v1/assets/urls — kills the N+1
//     `/api/v1/assets/:id/url` round-trip pattern the old grids triggered.
//   - Virtualisation via @tanstack/react-virtual once the list is large
//     enough to matter (≥500 rows in grid mode, ≥200 in list mode).
//
// Selection state is owned by the parent's ToolbarStateAPI (the hook keeps
// the Set + the toggle/range helpers); this component is purely
// presentational over it.

"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Image as ImageIcon } from "lucide-react";
import { PhotoCard, type Asset } from "./photo-card";
import { cn } from "@/lib/utils";
import type {
  Density,
  ToolbarStateAPI,
  ViewMode,
} from "@/lib/hooks/use-toolbar-state";

// Column counts per density × responsive breakpoint. The CSS grid handles
// the visual layout; the JS column count is only used for virtualisation
// row chunking, so we pick a value that's close enough to the final visual
// column count to avoid layout thrash.
function columnsFor(density: Density, width: number): number {
  if (width < 480) return density === "dense" ? 4 : density === "compact" ? 3 : 2;
  if (width < 768) return density === "dense" ? 6 : density === "compact" ? 4 : 3;
  if (width < 1280) return density === "dense" ? 8 : density === "compact" ? 6 : 4;
  return density === "dense" ? 10 : density === "compact" ? 8 : 6;
}

const VIRT_THRESHOLD_GRID = 500;
const VIRT_THRESHOLD_LIST = 200;
const BATCH_URL_CHUNK = 250;

interface AssetGridProps {
  assets: Asset[];
  toolbar: ToolbarStateAPI;
  /** "grid" or "list". Map/timeline are page-level swaps, not grid modes. */
  viewMode?: Extract<ViewMode, "grid" | "list">;
  /** Override density (default reads from toolbar.view.density). */
  density?: Density;
  onAssetClick?: (assetId: string, index: number) => void;
  onAddToCollection?: (assetId: string) => void;
  onRemove?: (assetId: string) => void;
  /** Class hook for the outer container. */
  className?: string;
  /** When empty, render this instead of the empty grid. */
  emptyState?: React.ReactNode;
}

export function AssetGrid({
  assets,
  toolbar,
  viewMode,
  density,
  onAssetClick,
  onAddToCollection,
  onRemove,
  className,
  emptyState,
}: AssetGridProps) {
  const mode = viewMode ?? (toolbar.view.viewMode === "list" ? "list" : "grid");
  const dens = density ?? toolbar.view.density;

  const orderedIds = useMemo(() => assets.map((a) => a.id), [assets]);
  const lastClickedRef = useRef<string | null>(null);

  const { thumbUrls, responsiveUrls } = useBatchThumbUrls(orderedIds);

  // Container width drives the column count. ResizeObserver is the only
  // source of truth — `window.innerWidth` would be wrong inside a split
  // pane (e.g. documents 3-column rebuild).
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1024);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  function handleSelect(assetId: string, e?: React.MouseEvent): void {
    if (e?.shiftKey && lastClickedRef.current) {
      toolbar.selectRange(orderedIds, lastClickedRef.current, assetId);
    } else {
      toolbar.toggleSelect(assetId);
    }
    lastClickedRef.current = assetId;
  }

  if (assets.length === 0) {
    return (
      <div className={cn("flex-1", className)}>
        {emptyState ?? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--ft-color-on-surface-variant)]">
            <ImageIcon className="mb-2 h-8 w-8 opacity-50" />
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]">No assets to show.</p>
          </div>
        )}
      </div>
    );
  }

  // Pick a render path: virtualise when the list is big enough that DOM
  // count would actually hurt, otherwise render directly so layout shifts
  // are zero and Cmd-F / inspector work on every tile.
  const virtualise =
    mode === "grid"
      ? assets.length >= VIRT_THRESHOLD_GRID
      : assets.length >= VIRT_THRESHOLD_LIST;

  if (mode === "list") {
    return (
      <div ref={containerRef} className={cn("flex-1", className)}>
        {virtualise ? (
          <VirtualList
            assets={assets}
            toolbar={toolbar}
            thumbUrls={thumbUrls}
            onAssetClick={onAssetClick}
            onSelect={handleSelect}
          />
        ) : (
          <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
            {assets.map((a, i) => (
              <AssetRow
                key={a.id}
                asset={a}
                index={i}
                thumbUrl={thumbUrls[a.id]}
                selected={toolbar.selectedIds.has(a.id)}
                selectMode={toolbar.selectMode}
                onSelect={(e) => handleSelect(a.id, e)}
                onClick={() => onAssetClick?.(a.id, i)}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  const cols = columnsFor(dens, containerWidth);

  return (
    <div ref={containerRef} className={cn("flex-1", className)}>
      {virtualise ? (
        <VirtualGrid
          assets={assets}
          cols={cols}
          toolbar={toolbar}
          thumbUrls={thumbUrls}
          responsiveUrls={responsiveUrls}
          onAssetClick={onAssetClick}
          onSelect={handleSelect}
          onAddToCollection={onAddToCollection}
          onRemove={onRemove}
        />
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {assets.map((a, i) => (
            <PhotoCard
              key={a.id}
              asset={a}
              thumbUrl={thumbUrls[a.id]}
              responsiveUrls={responsiveUrls[a.id]}
              selected={toolbar.selectedIds.has(a.id)}
              selectMode={toolbar.selectMode}
              onSelect={(e) => handleSelect(a.id, e)}
              onClick={() => onAssetClick?.(a.id, i)}
              onAddToCollection={onAddToCollection}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- batched thumb URL fetch ---------------------------------------------

/** T2.3b — responsive variant set sent on every batch request. The grid
 *  cards render a <picture> w/ AVIF + WebP <source>s at 256/512/1024 so the
 *  browser picks the smallest format it supports; including "thumb" (the
 *  legacy 256 webp) covers two cases:
 *    1. <img> fallback for ancient browsers and the AssetRow list view,
 *    2. unbackfilled rows where the new responsive columns are still NULL
 *       (the URL endpoint transparently falls through to thumb in that case).
 */
const RESPONSIVE_VARIANTS = [
  "thumb",
  "thumb-256-avif",
  "thumb-512-webp",
  "thumb-512-avif",
  "thumb-1024-webp",
  "thumb-1024-avif",
] as const;

interface BatchThumbUrls {
  /** Legacy 256-webp URL per id. Kept around for the list view + as the
   *  <img> fallback inside <picture>. */
  thumbUrls: Record<string, string | null>;
  /** Full per-variant URL map per id. Empty object ⇒ batch hasn't resolved
   *  yet (or row is missing); PhotoCard treats empty as "render legacy
   *  thumb path" via the thumbUrl prop. */
  responsiveUrls: Record<string, Record<string, string>>;
}

/** Returns stable per-id URL maps kept up-to-date with the current asset id
 *  list. Fetches in BATCH_URL_CHUNK-sized POSTs to /api/v1/assets/urls using
 *  the multi-variant request shape. Ids that are already known are not
 *  refetched. */
function useBatchThumbUrls(ids: string[]): BatchThumbUrls {
  const [thumbUrls, setThumbUrls] = useState<Record<string, string | null>>({});
  const [responsiveUrls, setResponsiveUrls] = useState<
    Record<string, Record<string, string>>
  >({});
  // Snapshot the known keys so the effect deps stay stable; the id list is a
  // new array reference on every parent render.
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (ids.length === 0) return;
    const missing = ids.filter((id) => !knownRef.current.has(id));
    if (missing.length === 0) return;

    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_URL_CHUNK) {
      chunks.push(missing.slice(i, i + BATCH_URL_CHUNK));
    }

    (async () => {
      for (const chunk of chunks) {
        try {
          const r = await fetch("/api/v1/assets/urls", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ids: chunk,
              variants: RESPONSIVE_VARIANTS,
            }),
          });
          if (!r.ok) {
            // Mark the chunk as known-failed so we don't loop on a 500.
            for (const id of chunk) knownRef.current.add(id);
            continue;
          }
          const d = (await r.json()) as {
            urls?: Record<string, Record<string, string>>;
          };
          if (cancelled) return;
          setThumbUrls((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              knownRef.current.add(id);
              next[id] = d.urls?.[id]?.["thumb"] ?? null;
            }
            return next;
          });
          setResponsiveUrls((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              const m = d.urls?.[id];
              if (m) next[id] = m;
            }
            return next;
          });
        } catch {
          for (const id of chunk) knownRef.current.add(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ids]);

  return { thumbUrls, responsiveUrls };
}

// ---- list row -------------------------------------------------------------

interface AssetRowProps {
  asset: Asset;
  index: number;
  thumbUrl?: string | null;
  selected: boolean;
  selectMode: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

function AssetRow({
  asset,
  thumbUrl,
  selected,
  selectMode,
  onSelect,
  onClick,
}: AssetRowProps) {
  const isImage = asset.mimeType.startsWith("image/");
  return (
    <li>
      <button
        onClick={(e) => (selectMode ? onSelect(e) : onClick())}
        className={cn(
          "flex w-full items-center gap-[var(--ft-space-3)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-left transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]",
          selected && "bg-[var(--ft-color-secondary-container)]"
        )}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)]">
          {isImage && thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrl}
              alt={asset.description ?? asset.filename}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <ImageIcon className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
            {asset.filename}
          </p>
          <p className="truncate text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
            {asset.mimeType} ·{" "}
            {Math.round(asset.sizeBytes / 1024).toLocaleString()} KB
            {asset.capturedAt
              ? ` · ${new Date(asset.capturedAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
      </button>
    </li>
  );
}

// ---- virtualised grid -----------------------------------------------------

interface VirtualGridProps {
  assets: Asset[];
  cols: number;
  toolbar: ToolbarStateAPI;
  thumbUrls: Record<string, string | null>;
  responsiveUrls: Record<string, Record<string, string>>;
  onAssetClick?: (assetId: string, index: number) => void;
  onSelect: (assetId: string, e?: React.MouseEvent) => void;
  onAddToCollection?: (assetId: string) => void;
  onRemove?: (assetId: string) => void;
}

function VirtualGrid({
  assets,
  cols,
  toolbar,
  thumbUrls,
  responsiveUrls,
  onAssetClick,
  onSelect,
  onAddToCollection,
  onRemove,
}: VirtualGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(assets.length / cols);

  // Square tiles. Row height ≈ container width / cols. We don't have that
  // measurement here, so we estimate from a typical breakpoint; the
  // virtualizer is forgiving — it re-measures on resize via measureElement.
  const rowVirt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 220,
    overscan: 4,
  });

  return (
    <div
      ref={parentRef}
      className="h-[calc(100vh-160px)] overflow-auto"
    >
      <div
        style={{
          height: rowVirt.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirt.getVirtualItems().map((vRow) => {
          const start = vRow.index * cols;
          const rowAssets = assets.slice(start, start + cols);
          return (
            <div
              key={vRow.key}
              ref={rowVirt.measureElement}
              data-index={vRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              <div
                className="grid gap-2 py-1"
                style={{
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                }}
              >
                {rowAssets.map((a, i) => (
                  <PhotoCard
                    key={a.id}
                    asset={a}
                    thumbUrl={thumbUrls[a.id]}
                    responsiveUrls={responsiveUrls[a.id]}
                    selected={toolbar.selectedIds.has(a.id)}
                    selectMode={toolbar.selectMode}
                    onSelect={(e) => onSelect(a.id, e)}
                    onClick={() => onAssetClick?.(a.id, start + i)}
                    onAddToCollection={onAddToCollection}
                    onRemove={onRemove}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- virtualised list -----------------------------------------------------

interface VirtualListProps {
  assets: Asset[];
  toolbar: ToolbarStateAPI;
  thumbUrls: Record<string, string | null>;
  onAssetClick?: (assetId: string, index: number) => void;
  onSelect: (assetId: string, e?: React.MouseEvent) => void;
}

function VirtualList({
  assets,
  toolbar,
  thumbUrls,
  onAssetClick,
  onSelect,
}: VirtualListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // T2.5 (fonto-perf-audit 2026-06-15): dropped overscan 10 → 5. At 56px row
  // height that's still ~280 px of pre-rendered DOM beyond the viewport edge
  // (well past the safe pre-render budget for arrow-key scroll) while halving
  // the offscreen DOM cost on low-end mobile rendering 10k+ asset feeds.
  const rowVirt = useVirtualizer({
    count: assets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  return (
    <div
      ref={parentRef}
      className="h-[calc(100vh-160px)] overflow-auto"
    >
      <div
        style={{
          height: rowVirt.getTotalSize(),
          position: "relative",
        }}
      >
        {rowVirt.getVirtualItems().map((vRow) => {
          const a = assets[vRow.index];
          return (
            <Fragment key={vRow.key}>
              <div
                ref={rowVirt.measureElement}
                data-index={vRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
                  <AssetRow
                    asset={a}
                    index={vRow.index}
                    thumbUrl={thumbUrls[a.id]}
                    selected={toolbar.selectedIds.has(a.id)}
                    selectMode={toolbar.selectMode}
                    onSelect={(e) => onSelect(a.id, e)}
                    onClick={() => onAssetClick?.(a.id, vRow.index)}
                  />
                </ul>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
