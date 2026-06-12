// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef } from "react";
import { Image as ImageIcon, Loader2, Check, MoreVertical, FolderPlus, Download, Trash2, Heart, Star, Layers, Play, Share2 } from "lucide-react";
import { Card } from "@/components/ui/card";

export interface Asset {
  id: string;
  // Phase 7b — serializeAsset already includes this; declaring on the TS
  // interface so UI components can pass it through to share controls.
  workspaceId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  processingState: string;
  capturedAt: string | null;
  createdAt: string;
  // Phase 3.4 — favorites + ratings. Both default to "unset" on legacy rows
  // before the backfill stamps them, so we keep these optional on the client.
  isFavorite?: boolean;
  rating?: number;
  // Phase B6 (storage placement) — per-asset policy override (null = follow the
  // workspace default) + local-mirror marker (a timestamp ⇒ a verified local
  // copy of the original exists). Serialized straight from the row.
  storagePolicyOverride?: string | null;
  localOriginalStoredAt?: string | null;
  // Phase 5.5 — manual stacks. NULL/undefined ⇒ standalone. When set, the
  // timeline only shows the primary; clicking opens the lightbox which
  // surfaces a "stack of N" badge with inline carousel of all members.
  stackId?: string | null;
  // Phase 5.5 — when this asset is the primary of a stack, the list
  // endpoint includes the member count so PhotoCard can render a badge
  // without a per-tile round trip. NULL for standalone assets.
  stackMemberCount?: number | null;
  // Phase 8a — video probe output. NULL for non-video assets.
  durationSeconds?: number | null;
  videoCodec?: string | null;
  videoWidth?: number | null;
  videoHeight?: number | null;
  // Image pixel dimensions (EXIF at ingest) + document page count (PDF
  // worker). Serialized straight from the row; null when unknown.
  widthPx?: number | null;
  heightPx?: number | null;
  pageCount?: number | null;
  // Phase 6.12 — extracted text layer (plain text / markdown / source file
  // contents). Populated on the per-asset detail endpoint, not the grid list.
  ocrText?: string | null;
  // Phase 7b — populated when the asset is being rendered through a
  // cross-workspace share (i.e. in the recipient's grid). Absent for
  // assets the caller owns directly. Used to render the "shared from
  // <workspace>" badge + tooltip.
  sharedFrom?: {
    workspaceId: string;
    workspaceName: string;
    accessLevel: string;
    createdBy: string;
    sharedAt: string;
  } | null;
}

/** Phase 8a — "1:23" / "12:34" / "1:02:03". Plays nicely w/ the grid chip. */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`;
}

interface QuickActionsProps {
  asset: Asset;
  onAddToCollection?: (assetId: string) => void;
  onRemove?: (assetId: string) => void;
  showRemove?: boolean;
}

function QuickActionsMenu({ asset, onAddToCollection, onRemove, showRemove }: QuickActionsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => r.json())
      .then((d) => {
        if (d.url) {
          const a = document.createElement("a");
          a.href = d.url;
          a.download = asset.filename;
          a.click();
        }
      });
    setOpen(false);
  }

  function handleTrash(e: React.MouseEvent) {
    e.stopPropagation();
    fetch(`/api/v1/assets/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trash: true }),
    });
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium bg-black/60 text-white hover:bg-black/80 transition-colors"
      >
        <MoreVertical className="h-3 w-3" />
        <span>More</span>
      </button>
      {open && (
        <div className="absolute bottom-7 right-0 z-20 min-w-36 rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container)] shadow-[var(--ft-elev-2)] py-[var(--ft-space-2)]">
          {onAddToCollection && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToCollection(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Add to Collection
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          {showRemove && onRemove && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from Collection
            </button>
          )}
          {!showRemove && (
            <button
              onClick={handleTrash}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Move to Trash
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface PhotoCardProps {
  asset: Asset;
  selected?: boolean;
  onSelect?: (e?: React.MouseEvent) => void;
  selectMode?: boolean;
  showQuickActions?: boolean;
  onRemove?: (assetId: string) => void;
  onAddToCollection?: (assetId: string) => void;
  onClick?: () => void;
  /** UX-3 — pre-resolved thumb URL from the batch URL endpoint. When set the
   *  card skips its per-tile /api/v1/assets/:id/url fetch entirely. AssetGrid
   *  uses this; legacy call-sites that pass nothing keep the old behavior. */
  thumbUrl?: string | null;
}

export function PhotoCard({
  asset,
  selected = false,
  onSelect,
  selectMode = false,
  showQuickActions = true,
  onRemove,
  onAddToCollection,
  onClick,
  thumbUrl,
}: PhotoCardProps) {
  // Two sources for the displayed url:
  //   - `thumbUrl` prop (UX-3 batch URL endpoint): supplied by AssetGrid, wins.
  //   - `fetchedUrl` state: legacy per-card fetch fallback for call-sites
  //     that don't go through AssetGrid yet.
  // Derived `url` keeps setState out of effects (React 19 compiler complains
  // about effects that sync prop → state).
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const url = thumbUrl !== undefined ? thumbUrl : fetchedUrl;
  // Initialise from the mime so non-image rows never flash the spinner
  // for the one frame between mount and effect-fire. If a batch URL was
  // already supplied we're never in loading state.
  const [loading, setLoading] = useState(() =>
    thumbUrl !== undefined ? false : asset.mimeType.startsWith("image/")
  );
  const [hovered, setHovered] = useState(false);

  // Only pulse for states the worker is *actively* moving through. "captured"
  // is the initial post-upload state — if it stays there it means the worker
  // never picked the row up, which is a stuck condition we don't want to
  // animate forever (that's the flashing the user sees across the grid).
  // "failed" is terminal and also gets no pulse.
  const isProcessing =
    asset.processingState === "processing" ||
    asset.processingState === "extracted";

  useEffect(() => {
    // UX-3 — when a batch URL is supplied, derived `url` covers it; skip the
    // legacy per-card fetch entirely.
    if (thumbUrl !== undefined) return;
    // Non-image rows never enter loading state (initial useState handles
    // that), so nothing to do here either.
    if (!asset.mimeType.startsWith("image/")) return;
    // Phase 1.1 — grid cells request the 256px thumb variant. The URL route
    // transparently falls back to the original if the derivative hasn't been
    // generated yet (legacy assets, in-flight backfill), so unbackfilled
    // rows still render — just slowly, like before.
    fetch(`/api/v1/assets/${asset.id}/url?variant=thumb`)
      .then((r) => r.json())
      .then((d) => setFetchedUrl(d.url ?? null))
      .catch(() => setFetchedUrl(null))
      .finally(() => setLoading(false));
  }, [asset.id, asset.mimeType, thumbUrl]);

  function handleClick(e: React.MouseEvent) {
    if (selectMode && onSelect) {
      onSelect(e);
    } else if (onClick) {
      onClick();
    }
  }

  return (
    // ADR 0009 phase 2 (group D) — outer chrome now resolves through the
    // MD3 <Card variant="filled"> primitive (surface-container-highest +
    // 12 px shape). Image, badges, checkbox, and quick-actions positioning
    // are unchanged per migration rule 1.
    <Card
      variant="filled"
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // UX-2 — drag handle for the /folders drop target. Carries the
      // asset id under a fonto-scoped MIME type so other drop zones
      // can recognise it without sniffing text payloads.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-fonto-asset", asset.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`relative cursor-pointer overflow-hidden transition-all ${
        selected
          ? "ring-2 ring-[var(--ft-color-primary)] ring-offset-1"
          : "ring-0"
      } ${isProcessing ? "animate-pulse ring-1 ring-[var(--ft-color-tertiary)]/50" : ""}`}
    >
      {/* Image */}
      <div className="aspect-square bg-[var(--ft-color-surface-container)]/30 flex items-center justify-center overflow-hidden">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-[var(--ft-color-on-surface-variant)]" />
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.description ?? asset.filename}
            className="h-full w-full object-cover"
            loading="lazy"
            // Phase 3 perf — decode off-main-thread so a new month entering
            // the viewport doesn't block the scroll frame on image decode.
            decoding="async"
          />
        ) : (
          <ImageIcon className="h-8 w-8 text-[var(--ft-color-on-surface-variant)]" />
        )}
      </div>

      {/* Phase 8a — video play-icon overlay + duration chip. Renders for
          any video/* mime; duration shows only when probed. Bottom-right
          chip uses the same visual weight as the stack-count badge. */}
      {asset.mimeType.startsWith("video/") && (
        <>
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="rounded-full bg-black/60 p-2.5">
              <Play
                className="h-5 w-5 text-white"
                fill="currentColor"
              />
            </div>
          </div>
          {asset.durationSeconds != null && (
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {formatDuration(asset.durationSeconds)}
            </div>
          )}
        </>
      )}

      {/* Hover overlay */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-150 ${
          hovered || selected || selectMode ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Phase 5.5 — stack badge. Top-right when no checkbox, slides
          left to make room for the checkbox when select mode is on. */}
      {asset.stackMemberCount != null && asset.stackMemberCount > 1 && (
        <div
          className={`absolute top-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white pointer-events-none ${
            selectMode || hovered || selected ? "right-8" : "right-1.5"
          }`}
        >
          <Layers className="h-2.5 w-2.5" />
          {asset.stackMemberCount}
        </div>
      )}

      {/* Phase 3.4 — favorite heart (always visible when set; subtle).
          Lives bottom-left so it doesn't fight with checkbox (top-right)
          or quick actions (bottom-right). */}
      {asset.isFavorite && (
        <div className="absolute bottom-1.5 left-1.5 z-10 pointer-events-none">
          <Heart
            className="h-3.5 w-3.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
            fill="currentColor"
          />
        </div>
      )}

      {/* Phase 7b — cross-workspace share badge. Shown only when the
          asset is rendered through a share grant (recipient view). Sits
          to the right of the favorite heart so both can coexist. */}
      {asset.sharedFrom && (
        <div
          className={`absolute bottom-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white pointer-events-none ${
            asset.isFavorite ? "left-7" : "left-1.5"
          }`}
          title={`Shared from ${asset.sharedFrom.workspaceName} (${asset.sharedFrom.accessLevel})`}
        >
          <Share2 className="h-2.5 w-2.5" />
          {asset.sharedFrom.workspaceName}
        </div>
      )}
      {/* Phase 3.4 — star rating badge. Top-left, tiny. Only shown when
          rated > 0 so unrated assets stay visually quiet. */}
      {asset.rating !== undefined && asset.rating > 0 && (
        <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white pointer-events-none">
          <Star className="h-2.5 w-2.5" fill="currentColor" />
          {asset.rating}
        </div>
      )}

      {/* Top-right: checkbox */}
      {(selectMode || hovered || selected) && (
        <div
          className="absolute top-1.5 right-1.5 z-10"
          onClick={(e) => { e.stopPropagation(); onSelect?.(e); }}
        >
          <div
            className={`h-5 w-5 rounded-[var(--ft-shape-full)] border-2 flex items-center justify-center transition-colors ${
              selected
                ? "bg-[var(--ft-color-primary)] border-[var(--ft-color-primary)]"
                : "bg-black/40 border-white/80"
            }`}
          >
            {selected && <Check className="h-3 w-3 text-[var(--ft-color-on-primary)]" />}
          </div>
        </div>
      )}

      {/* Bottom: quick actions */}
      {showQuickActions && hovered && !selectMode && (
        <div className="absolute bottom-1.5 right-1.5 z-10">
          <QuickActionsMenu
            asset={asset}
            onAddToCollection={onAddToCollection}
            onRemove={onRemove}
            showRemove={!!onRemove}
          />
        </div>
      )}
    </Card>
  );
}
