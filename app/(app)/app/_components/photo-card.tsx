// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef } from "react";
import { Image as ImageIcon, Loader2, Check, MoreVertical, FolderPlus, Download, Trash2 } from "lucide-react";

export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  processingState: string;
  capturedAt: string | null;
  createdAt: string;
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
        <div className="absolute bottom-7 right-0 z-20 min-w-36 rounded-lg border border-border bg-popover shadow-lg py-1">
          {onAddToCollection && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToCollection(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Add to Collection
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          {showRemove && onRemove && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-muted transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from Collection
            </button>
          )}
          {!showRemove && (
            <button
              onClick={handleTrash}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-muted transition-colors"
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
  onSelect?: () => void;
  selectMode?: boolean;
  showQuickActions?: boolean;
  onRemove?: (assetId: string) => void;
  onAddToCollection?: (assetId: string) => void;
  onClick?: () => void;
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
}: PhotoCardProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState(false);

  const isProcessing = asset.processingState !== "ready";

  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) {
      setLoading(false);
      return;
    }
    // Phase 1.1 — grid cells request the 256px thumb variant. The URL route
    // transparently falls back to the original if the derivative hasn't been
    // generated yet (legacy assets, in-flight backfill), so unbackfilled
    // rows still render — just slowly, like before.
    fetch(`/api/v1/assets/${asset.id}/url?variant=thumb`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => setUrl(null))
      .finally(() => setLoading(false));
  }, [asset.id, asset.mimeType]);

  function handleClick() {
    if (selectMode && onSelect) {
      onSelect();
    } else if (onClick) {
      onClick();
    }
  }

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative cursor-pointer overflow-hidden rounded-lg transition-all ${
        selected
          ? "ring-2 ring-primary ring-offset-1"
          : "ring-0"
      } ${isProcessing ? "animate-pulse ring-1 ring-yellow-500/50" : ""}`}
    >
      {/* Image */}
      <div className="aspect-square bg-muted/30 flex items-center justify-center overflow-hidden">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.description ?? asset.filename}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <ImageIcon className="h-8 w-8 text-muted-foreground" />
        )}
      </div>

      {/* Hover overlay */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-150 ${
          hovered || selected || selectMode ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Top-right: checkbox */}
      {(selectMode || hovered || selected) && (
        <div
          className="absolute top-1.5 right-1.5 z-10"
          onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
        >
          <div
            className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${
              selected
                ? "bg-primary border-primary"
                : "bg-black/40 border-white/80"
            }`}
          >
            {selected && <Check className="h-3 w-3 text-white" />}
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
    </div>
  );
}
