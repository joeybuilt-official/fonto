// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  X, ChevronLeft, ChevronRight, Info, Tag, FolderPlus, Download,
  Trash2, Plus, Loader2, Share2, Check, Copy, Settings, Heart, Star, Layers, MessageCircle,
  ScanSearch, EyeOff, RotateCcw, RotateCw, FlipVertical, Crop as CropIcon, CornerUpLeft,
  Play, Pause, CircleDot
} from "lucide-react";
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop as ReactCropValue,
  type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import type { Asset } from "./photo-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmButton } from "@/components/confirm-button";
import { ShareDialog } from "./share-dialog";
import { CommentsPanel } from "./comments-panel";
import { AssetWorkspaceShare } from "./asset-workspace-share";
import { VideoPlayer } from "./video-player";
import { useSession } from "@/lib/auth/client";

// Task #33 — tiny in-component toast queue. The repo doesn't ship a global
// toast surface (uploads-section.tsx rolls its own), so we follow the same
// pattern locally. Auto-dismisses after 3s; failure variants live longer so
// the user can read the error before they leave.
interface LightboxToast {
  id: number;
  kind: "success" | "error";
  message: string;
}

// M8 — slideshow dwell per slide.
const SLIDESHOW_MS = 4000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Phase 6.12 — text/code assets (text/plain, text/markdown, text/x-*) have no
// rasterized preview; we render their extracted text layer in a monospace
// panel instead. `.md`/source files lean toward a "code" presentation.
function isTextLike(mimeType: string): boolean {
  return mimeType.startsWith("text/");
}
function isCodeLike(mimeType: string): boolean {
  return mimeType !== "text/plain" && mimeType.startsWith("text/");
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

interface TagItem {
  id: string;
  name: string;
  color: string;
}

// Phase 2 (faces/UX) — a detected face on the displayed asset, as returned by
// GET /api/v1/assets/:id/faces. bbox is normalized 0..1 against the full image.
interface LightboxFace {
  id: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  personId: string | null;
  personName: string | null;
}

interface Collection {
  id: string;
  name: string;
}

interface MetadataPanelProps {
  asset: Asset;
  tags: TagItem[];
  allTags: TagItem[];
  collections: Collection[];
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onCreateTag: (name: string) => Promise<void>;
  onAddToCollection: (collectionId: string) => void;
  onDownload: () => void;
  onTrash: () => void;
  onShare: () => Promise<void>;
  shareState: { url: string | null; copied: boolean; loading: boolean };
  onRevokeShare: () => Promise<void>;
  onOpenShareDialog: () => void;
  onOpenSimilar: (id: string) => void;
}

function MetadataPanel({
  asset,
  tags,
  allTags,
  collections,
  onAddTag,
  onRemoveTag,
  onCreateTag,
  onAddToCollection,
  onDownload,
  onTrash,
  onShare,
  shareState,
  onRevokeShare,
  onOpenShareDialog,
  onOpenSimilar,
}: MetadataPanelProps) {
  const [addingTag, setAddingTag] = useState(false);
  // "More like this" — CLIP image kNN over the asset's own embedding
  // (GET /api/v1/assets/:id/similar). Falls back to same-classification
  // server-side when no embedding exists yet.
  const [similar, setSimilar] = useState<Asset[] | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);

  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) {
      setSimilar(null);
      return;
    }
    let cancelled = false;
    setSimilarLoading(true);
    fetch(`/api/v1/assets/${asset.id}/similar`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { assets?: Asset[] } | null) => {
        if (!cancelled) setSimilar(d?.assets ?? []);
      })
      .catch(() => {
        if (!cancelled) setSimilar([]);
      })
      .finally(() => {
        if (!cancelled) setSimilarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.mimeType]);
  const [tagInput, setTagInput] = useState("");
  const [showCollections, setShowCollections] = useState(false);
  const [rescanState, setRescanState] = useState<"idle" | "loading" | "done">("idle");
  // Phase B6 — per-asset storage-placement override. "" = follow workspace default.
  const [override, setOverride] = useState<string>(asset.storagePolicyOverride ?? "");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const colRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOverride(asset.storagePolicyOverride ?? "");
  }, [asset.id, asset.storagePolicyOverride]);

  async function handleOverrideChange(next: string) {
    if (overrideBusy || next === override) return;
    setOverrideBusy(true);
    const prev = override;
    setOverride(next); // optimistic
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // "" → null clears the override (asset follows the workspace policy).
        body: JSON.stringify({ storagePolicyOverride: next === "" ? null : next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setOverride(prev); // revert on failure
    } finally {
      setOverrideBusy(false);
    }
  }

  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus();
  }, [addingTag]);

  useEffect(() => {
    if (!showCollections) return;
    function onClick(e: MouseEvent) {
      if (colRef.current && !colRef.current.contains(e.target as Node)) setShowCollections(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showCollections]);

  const tagIds = new Set(tags.map((t) => t.id));
  const unassignedTags = allTags.filter((t) => !tagIds.has(t.id));

  async function handleRescan() {
    if (rescanState === "loading") return;
    setRescanState("loading");
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}/reprocess`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRescanState("done");
      setTimeout(() => setRescanState("idle"), 4000);
    } catch {
      setRescanState("idle");
    }
  }

  async function handleTagSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const name = tagInput.trim();
    if (!name) return;
    // Check if existing tag matches
    const existing = allTags.find((t) => t.name === name.toLowerCase());
    if (existing) {
      onAddTag(existing.id);
    } else {
      await onCreateTag(name);
    }
    setTagInput("");
    setAddingTag(false);
  }

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-full max-w-sm shrink-0 overflow-y-auto border-l border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] sm:static sm:inset-auto sm:z-auto sm:w-72 sm:max-w-none">
      <div className="p-4 space-y-5">
        {/* DETAILS */}
        <div>
          <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-2">Details</p>
          <div className="space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Filename</span>
              <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] text-right truncate max-w-36" title={asset.filename}>{asset.filename}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Size</span>
              <span className="text-xs text-foreground">{formatBytes(asset.sizeBytes)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Captured</span>
              <span className="text-xs text-foreground">{formatDate(asset.capturedAt)}</span>
            </div>
            {asset.classification && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Type</span>
                <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] capitalize">{asset.classification}</span>
              </div>
            )}
            {(() => {
              const w = asset.widthPx ?? asset.videoWidth;
              const h = asset.heightPx ?? asset.videoHeight;
              return w && h ? (
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Dimensions</span>
                  <span className="text-xs text-foreground">{w} × {h}</span>
                </div>
              ) : null;
            })()}
            {asset.pageCount != null && asset.pageCount > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Pages</span>
                <span className="text-xs text-foreground">{asset.pageCount}</span>
              </div>
            )}
            {asset.durationSeconds != null && asset.durationSeconds > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--ft-color-on-surface-variant)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] shrink-0">Duration</span>
                <span className="text-xs text-foreground">
                  {Math.floor(asset.durationSeconds / 60)}:
                  {String(Math.round(asset.durationSeconds % 60)).padStart(2, "0")}
                </span>
              </div>
            )}
            {/* Phase B6 — per-asset storage placement. Default = follow the
                workspace policy; override to pin this one asset. local_only is
                deferred (C4), so only Default / Cloud / Mirror are offered. */}
            <div className="flex justify-between gap-2 items-center">
              <span className="text-muted-foreground text-xs shrink-0">Storage</span>
              <div className="flex items-center gap-1.5">
                {asset.localOriginalStoredAt && (
                  <span
                    className="text-[10px] text-green-500"
                    title="A verified copy of the original is on your NAS disk"
                  >
                    On NAS
                  </span>
                )}
                <select
                  value={override}
                  onChange={(e) => handleOverrideChange(e.target.value)}
                  disabled={overrideBusy}
                  aria-label="Storage placement for this asset"
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">Default</option>
                  <option value="r2_only">Cloud only</option>
                  <option value="mirror">Mirror to NAS</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* DESCRIPTION */}
        {asset.description && (
          <div>
            <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-2">Description</p>
            <p className="text-[length:var(--ft-type-body-small-size)] leading-relaxed text-[var(--ft-color-on-surface)]">{asset.description}</p>
          </div>
        )}

        {/* TAGS */}
        <div>
          <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-2">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => onRemoveTag(tag.id)}
                className="flex items-center gap-1 rounded-[var(--ft-shape-full)] px-2 py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium bg-[var(--ft-color-surface-container)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-error-container)] hover:text-[var(--ft-color-on-error-container)] transition-colors"
                title="Click to remove"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
                <X className="h-2.5 w-2.5 ml-0.5" />
              </button>
            ))}
            {!addingTag && (
              <button
                onClick={() => setAddingTag(true)}
                className="flex items-center gap-1 rounded-[var(--ft-shape-full)] px-2 py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium border border-dashed border-[var(--ft-color-outline)] text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)] hover:border-[var(--ft-color-on-surface)] transition-colors"
              >
                <Plus className="h-2.5 w-2.5" />
                Add tag
              </button>
            )}
            {addingTag && (
              <div className="w-full mt-1 space-y-1">
                <input
                  ref={tagInputRef}
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagSubmit}
                  onBlur={() => { if (!tagInput.trim()) setAddingTag(false); }}
                  placeholder="Tag name (Enter to add)"
                  className="w-full rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-2 py-1 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] placeholder:text-[var(--ft-color-on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
                />
                {unassignedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {unassignedTags.slice(0, 6).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { onAddTag(t.id); setAddingTag(false); setTagInput(""); }}
                        className="rounded-[var(--ft-shape-full)] px-2 py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] bg-[var(--ft-color-surface-container)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-primary-container)] hover:text-[var(--ft-color-on-primary-container)] transition-colors"
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* MORE LIKE THIS — CLIP visual neighbours */}
        {asset.mimeType.startsWith("image/") &&
          (similarLoading || (similar && similar.length > 0)) && (
            <div>
              <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-2">
                More like this
              </p>
              {similarLoading ? (
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  Finding…
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {similar!.map((m) => (
                    <StackThumb
                      key={m.id}
                      asset={m}
                      active={false}
                      onClick={() => onOpenSimilar(m.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

        {/* ACTIONS */}
        <div>
          <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-2">Actions</p>
          <div className="space-y-1.5">
            {/* Add to Collection dropdown */}
            <div ref={colRef} className="relative">
              <button
                onClick={() => setShowCollections((v) => !v)}
                className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5 text-[var(--ft-color-on-surface-variant)]" />
                Add to Collection
                <ChevronLeft className={`h-3 w-3 ml-auto text-muted-foreground transition-transform ${showCollections ? "-rotate-90" : "rotate-90"}`} />
              </button>
              {showCollections && collections.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] shadow-[var(--ft-elev-2)] py-1 max-h-36 overflow-y-auto">
                  {collections.map((col) => (
                    <button
                      key={col.id}
                      onClick={() => { onAddToCollection(col.id); setShowCollections(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container-high)] transition-colors"
                    >
                      {col.name}
                    </button>
                  ))}
                </div>
              )}
              {showCollections && collections.length === 0 && (
                <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] shadow-[var(--ft-elev-2)] py-2 px-3">
                  <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">No collections yet</p>
                </div>
              )}
            </div>
            <button
              onClick={onDownload}
              className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors"
            >
              <Download className="h-3.5 w-3.5 text-[var(--ft-color-on-surface-variant)]" />
              Download
            </button>
            {/* Re-scan — re-run the full recognition pipeline (OCR, labels,
                description, faces) on the local vision/Ollama box. */}
            <button
              onClick={handleRescan}
              disabled={rescanState === "loading"}
              className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors disabled:opacity-50"
            >
              {rescanState === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : rescanState === "done" ? (
                <Check className="h-3.5 w-3.5 text-[var(--ft-color-success)]" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5 text-[var(--ft-color-on-surface-variant)]" />
              )}
              {rescanState === "done" ? "Re-scan queued" : "Re-scan (AI)"}
            </button>
            {/* Share */}
            <button
              onClick={onShare}
              disabled={shareState.loading}
              className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors disabled:opacity-50"
            >
              {shareState.copied ? (
                <Check className="h-3.5 w-3.5 text-[var(--ft-color-success)]" />
              ) : (
                <Share2 className="h-3.5 w-3.5 text-[var(--ft-color-on-surface-variant)]" />
              )}
              {shareState.copied
                ? "Link copied"
                : shareState.url
                ? "Copy share link"
                : shareState.loading
                ? "Generating…"
                : "Share (24h link)"}
            </button>
            {shareState.url && (
              <div className="flex items-center gap-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] px-2 py-1 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)]">
                <code className="flex-1 truncate font-mono text-[var(--ft-color-on-surface-variant)]">
                  {shareState.url}
                </code>
                <button
                  onClick={onShare}
                  className="rounded p-0.5 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
                  title="Copy"
                >
                  {shareState.copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
                <button
                  onClick={onRevokeShare}
                  className="rounded p-0.5 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-error)]"
                  title="Revoke link"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {/* Phase 2.5 — full share management (password, downloads, views). */}
            <button
              onClick={onOpenShareDialog}
              className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors"
            >
              <Settings className="h-3.5 w-3.5 text-[var(--ft-color-on-surface-variant)]" />
              Manage share links…
            </button>
            <ConfirmButton
              onConfirm={() => onTrash?.()}
              className="flex w-full items-center gap-2 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-error)]/30 bg-[var(--ft-color-surface)] px-3 py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)] hover:bg-[var(--ft-color-error-container)] transition-colors"
              armedClassName="bg-[var(--ft-color-error-container)] ring-1 ring-[var(--ft-color-error)]"
              confirmLabel={
                <span className="flex items-center gap-2 font-bold">
                  <Trash2 className="h-3.5 w-3.5" />
                  Confirm move to trash
                </span>
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
              Move to Trash
            </ConfirmButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface PhotoLightboxProps {
  asset: Asset;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onTrash?: (assetId: string) => void;
  // Phase 3.4 — optional callback so the parent can keep its asset list in
  // sync with favorite/rating mutations (otherwise the grid would still show
  // the old badge state when the lightbox closes).
  onAssetUpdate?: (assetId: string, patch: { isFavorite?: boolean; rating?: number }) => void;
  // T1.4 (perf audit) — optional neighbour asset ids. When provided the
  // lightbox warms the preview URL endpoint + image bytes for them so arrow
  // nav feels instant. Parent supplies these from its assets[lightboxIndex±1]
  // since the lightbox itself has no list awareness. Absent ⇒ no prefetch.
  prevAssetId?: string | null;
  nextAssetId?: string | null;
}

export function PhotoLightbox({
  asset,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onTrash,
  onAssetUpdate,
  prevAssetId,
  nextAssetId,
}: PhotoLightboxProps) {
  const session = useSession();
  // Better Auth's hook shape: { data: { user: { id, ... } } | null, ... }
  const currentUserId =
    (session.data as { user?: { id?: string } } | null | undefined)?.user?.id ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(true);
  // Phase 6.12 — extracted text layer for text/code assets, lazy-loaded from
  // the per-asset detail endpoint (the grid list omits ocrText).
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  // M8 — slideshow auto-advance. When on, advance to the next asset every
  // SLIDESHOW_MS; stops automatically at the end of the list.
  const [slideshow, setSlideshow] = useState(false);
  // Phase 7a — comments side-drawer toggle. Coexists with the info panel
  // so both can be open simultaneously on wide viewports; keyboard 'c'
  // shortcut wired below for parity with 'i' (info).
  const [showComments, setShowComments] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [allTags, setAllTags] = useState<TagItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Phase 3.4 — local optimistic state for favorite + rating. Initialized
  // from the incoming asset; the F / 1..5 / 0 keyboard shortcuts and the
  // toolbar buttons flip these immediately, then fire PATCH and revert on
  // failure. Reset whenever the visible asset id changes (prev/next nav).
  const [isFavorite, setIsFavorite] = useState<boolean>(!!asset.isFavorite);
  const [rating, setRating] = useState<number>(asset.rating ?? 0);
  // Phase 5.5 — stack expansion. When the visible asset belongs to a stack
  // we lazy-fetch its members the first time the user clicks the badge,
  // then render an inline carousel along the bottom. Members are sorted
  // primary-first by the server (`GET /api/v1/stacks/:id`).
  const [stackMembers, setStackMembers] = useState<Asset[] | null>(null);
  const [stackOpen, setStackOpen] = useState(false);
  const [stackLoading, setStackLoading] = useState(false);
  // When a stack member is clicked in the carousel we swap the displayed
  // image to that member without leaving the lightbox. Metadata panel +
  // share / favorite / rating stay keyed to the primary asset for now —
  // those actions are stack-level by design. Reset on prop asset change.
  const [viewMemberId, setViewMemberId] = useState<string | null>(null);

  // Task #33 — rotate / crop UX.
  //   - cacheBust forces the <img> to refetch after an in-place rotate
  //     (the URL endpoint returns the same presigned key, so we need a
  //     query param the browser doesn't already have in its cache).
  //   - transformBusy disables the rotate cluster + crop trigger while a
  //     request is in flight to prevent stacking rotations.
  //   - toasts: see LightboxToast above; rendered bottom-right.
  //   - cropOpen / cropValue / cropPixel back the crop modal.
  const router = useRouter();
  const [cacheBust, setCacheBust] = useState(0);
  const [transformBusy, setTransformBusy] = useState(false);
  const [toasts, setToasts] = useState<LightboxToast[]>([]);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropValue, setCropValue] = useState<ReactCropValue | undefined>(undefined);
  const [cropPixel, setCropPixel] = useState<PixelCrop | undefined>(undefined);
  const [cropSaving, setCropSaving] = useState(false);
  const cropImgRef = useRef<HTMLImageElement>(null);

  const pushToast = useCallback((kind: "success" | "error", message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    const ttl = kind === "error" ? 5000 : 3000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  // Phase 2 (faces/UX) — name-tag overlay. Mirrors the Flutter `_showNames`
  // pattern: fetch the asset's faces, render name chips positioned over each
  // bbox, and tap the image to toggle the chips on/off. Faces are normalized
  // 0..1 against the image; we map them onto the displayed (object-contain,
  // letterboxed) <img> via its measured rect (see imgRef below).
  const [faces, setFaces] = useState<LightboxFace[]>([]);
  const [showNames, setShowNames] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // Bumped on load/resize so the overlay recomputes against the live rect.
  const [imgRectTick, setImgRectTick] = useState(0);

  // M12 / ADR 0014 — motion (Live) photo playback. The clip URL is fetched
  // lazily on first hover/tap (not bundled in the list), then the <video>
  // overlays the still while active. `motionActive` is driven by hover on the
  // desktop + a tap toggle on touch.
  const [motionUrl, setMotionUrl] = useState<string | null>(null);
  const [motionActive, setMotionActive] = useState(false);
  const motionVideoRef = useRef<HTMLVideoElement | null>(null);
  const showMotion = asset.motionPhoto === true && !asset.mimeType.startsWith("video/");

  const stopMotion = useCallback(() => {
    setMotionActive(false);
    const v = motionVideoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
  }, []);

  useEffect(() => {
    setIsFavorite(!!asset.isFavorite);
    setRating(asset.rating ?? 0);
    // Reset stack expansion when the visible asset changes.
    setStackMembers(null);
    setStackOpen(false);
    setViewMemberId(null);
    // Task #33 — drop any pending cache-bust + crop state on nav.
    setCacheBust(0);
    setCropOpen(false);
    setCropValue(undefined);
    setCropPixel(undefined);
  }, [asset.id, asset.isFavorite, asset.rating]);

  // Phase 5.5 — fetch the members of `asset.stackId` once, on demand.
  // Stays a no-op for standalone assets.
  const stackId = asset.stackId ?? null;
  async function toggleStack() {
    if (!stackId) return;
    if (stackOpen) {
      setStackOpen(false);
      return;
    }
    setStackOpen(true);
    if (stackMembers !== null) return;
    setStackLoading(true);
    try {
      const res = await fetch(`/api/v1/stacks/${stackId}`);
      if (!res.ok) {
        setStackMembers([]);
        return;
      }
      const data = (await res.json()) as { assets?: Asset[] };
      setStackMembers(data.assets ?? []);
    } catch {
      setStackMembers([]);
    } finally {
      setStackLoading(false);
    }
  }

  // Picks the asset whose image is currently rendered. Defaults to the
  // prop `asset` (the primary in stack mode) but swaps to a clicked
  // stack member when set.
  const displayedAssetId = viewMemberId ?? asset.id;

  // M12 / ADR 0014 — lazily fetch the motion clip URL on first hover/tap.
  const startMotion = useCallback(async () => {
    if (!showMotion) return;
    setMotionActive(true);
    if (motionUrl) return;
    try {
      const r = await fetch(`/api/v1/assets/${displayedAssetId}/url?variant=motion`);
      const d = (await r.json()) as { url?: string };
      setMotionUrl(d.url ?? null);
    } catch {
      setMotionUrl(null);
    }
  }, [showMotion, motionUrl, displayedAssetId]);

  // Drop the cached clip URL when the visible asset changes (stack nav etc.).
  useEffect(() => {
    setMotionUrl(null);
    setMotionActive(false);
  }, [displayedAssetId]);

  useEffect(() => {
    setUrl(null);
    setUrlLoading(true);
    // Phase 1.1 — lightbox renders the 1080px preview variant. Falls back to
    // original on the server side if the derivative is missing.
    fetch(`/api/v1/assets/${displayedAssetId}/url?variant=preview`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => setUrl(null))
      .finally(() => setUrlLoading(false));
  }, [displayedAssetId]);

  // Phase 6.12 — fetch the text layer for text/code assets.
  useEffect(() => {
    if (!isTextLike(asset.mimeType)) {
      setTextContent(null);
      return;
    }
    setTextContent(null);
    setTextLoading(true);
    fetch(`/api/v1/assets/${displayedAssetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { asset?: { ocrText?: string | null } } | null) =>
        setTextContent(d?.asset?.ocrText ?? "")
      )
      .catch(() => setTextContent(""))
      .finally(() => setTextLoading(false));
  }, [displayedAssetId, asset.mimeType]);

  // Phase 2 (faces/UX) — fetch the displayed asset's faces for the name-tag
  // overlay. Reset the toggle per asset so chips don't carry across nav. Only
  // meaningful for images; skip text/video.
  useEffect(() => {
    setShowNames(false);
    setFaces([]);
    if (!asset.mimeType.startsWith("image/")) return;
    let cancelled = false;
    fetch(`/api/v1/assets/${displayedAssetId}/faces`)
      .then((r) => (r.ok ? r.json() : { faces: [] }))
      .then((d: { faces?: LightboxFace[] }) => {
        if (!cancelled) setFaces(d.faces ?? []);
      })
      .catch(() => {
        if (!cancelled) setFaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [displayedAssetId, asset.mimeType]);

  // Recompute overlay positions when the image resizes (responsive layout,
  // panel open/close changes the available width).
  useEffect(() => {
    function onResize() {
      setImgRectTick((t) => t + 1);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Recompute when the info / comments panels toggle (they shrink the image
  // area, so the letterboxing changes).
  useEffect(() => {
    setImgRectTick((t) => t + 1);
  }, [showPanel, showComments]);

  useEffect(() => {
    fetch(`/api/v1/assets/${asset.id}/tags`)
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => setTags(d.tags ?? []))
      .catch(() => setTags([]));
    // Reset share state per asset; surface most recent active link
    setShareUrl(null);
    setShareCopied(false);
    fetch(`/api/v1/assets/${asset.id}/share`)
      .then((r) => (r.ok ? r.json() : { links: [] }))
      .then((d: { links?: Array<{ token: string }> }) => {
        const first = d.links?.[0];
        if (first) {
          setShareUrl(`${window.location.origin}/share/${first.token}`);
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, [asset.id]);

  // T1.2 (perf audit) — `/api/v1/tags` and `/api/v1/collections` are
  // workspace-scoped invariants; they don't change as the user arrows
  // through assets. Fetch them once per workspace within the lightbox's
  // lifecycle instead of on every asset-nav (was ~400-700 ms metadata-panel
  // LCP per advance). asset.workspaceId is optional in the type but always
  // present in practice for owned assets; we still key the effect on the
  // value so cross-workspace shared assets refetch correctly.
  const workspaceId = asset.workspaceId ?? null;
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/tags")
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => {
        if (!cancelled) setAllTags(d.tags ?? []);
      })
      .catch(() => {
        if (!cancelled) setAllTags([]);
      });
    fetch("/api/v1/collections")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setCollections(d.collections ?? []);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // T1.4 (perf audit) — warm the preview URL endpoint + image bytes for the
  // immediate prev/next assets so arrow nav is ~30 ms perceived instead of
  // ~300 ms. Bounded to 1 neighbour each side; no list-wide prefetch. We
  // both (a) hit the URL endpoint so its cache entry is warm and (b) inject
  // `<link rel="prefetch" as="image" href={url}>` so the browser fetches
  // the bytes. Cleanup removes the link nodes when the active asset id
  // changes or the lightbox unmounts.
  useEffect(() => {
    const neighbours = [prevAssetId, nextAssetId].filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id !== asset.id
    );
    if (neighbours.length === 0) return;
    let cancelled = false;
    const linkEls: HTMLLinkElement[] = [];
    // T2.3b — also warm the preview-avif variant. The URL endpoint falls
    // back to legacy preview when preview-avif is NULL, so this is safe on
    // unbackfilled rows. Browsers that don't support AVIF will ignore the
    // <link rel=prefetch> mime hint and still pick the webp via the
    // displayed image's own <picture> source negotiation when we render it.
    for (const id of neighbours) {
      for (const variant of ["preview", "preview-avif"] as const) {
        fetch(`/api/v1/assets/${id}/url?variant=${variant}`)
          .then((r) => (r.ok ? r.json() : { url: null }))
          .then((d: { url?: string | null }) => {
            if (cancelled || !d?.url) return;
            const link = document.createElement("link");
            link.rel = "prefetch";
            link.as = "image";
            link.href = d.url;
            document.head.appendChild(link);
            linkEls.push(link);
          })
          .catch(() => {
            /* ignore */
          });
      }
    }
    return () => {
      cancelled = true;
      for (const link of linkEls) {
        if (link.parentNode) link.parentNode.removeChild(link);
      }
    };
  }, [asset.id, prevAssetId, nextAssetId]);

  // Phase 3.4 — optimistic PATCH for { isFavorite } / { rating }. Flips the
  // local state first, fires the request, reverts on failure. Bubbles the
  // committed state up so the grid's badges stay coherent when the lightbox
  // closes.
  const mutateAsset = useCallback(
    async (patch: { isFavorite?: boolean; rating?: number }) => {
      const prev = { isFavorite, rating };
      if (patch.isFavorite !== undefined) setIsFavorite(patch.isFavorite);
      if (patch.rating !== undefined) setRating(patch.rating);
      try {
        const res = await fetch(`/api/v1/assets/${asset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`PATCH ${res.status}`);
        onAssetUpdate?.(asset.id, patch);
      } catch {
        // Revert on failure. The optimistic UX is "snappy" — the only time
        // the user sees a flip-back is if the request actually fails, which
        // is rare for a single-row PATCH.
        setIsFavorite(prev.isFavorite);
        setRating(prev.rating);
      }
    },
    [asset.id, isFavorite, rating, onAssetUpdate]
  );

  const toggleFavorite = useCallback(() => {
    void mutateAsset({ isFavorite: !isFavorite });
  }, [mutateAsset, isFavorite]);

  const setRatingValue = useCallback(
    (next: number) => {
      // Tapping the current value clears it — matches Lightroom / Photos.
      const target = next === rating ? 0 : next;
      void mutateAsset({ rating: target });
    },
    [mutateAsset, rating]
  );

  // M8 — slideshow timer. Re-armed on every asset change (full dwell per
  // slide) and torn down when paused or at the end of the list.
  useEffect(() => {
    if (!slideshow) return;
    if (!hasNext) {
      setSlideshow(false);
      return;
    }
    const t = setTimeout(() => onNext(), SLIDESHOW_MS);
    return () => clearTimeout(t);
  }, [slideshow, hasNext, onNext, asset.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Phase 3.4 — never swallow keystrokes when the user is typing into a
      // text field. Without this guard, tagging "5g network" would mash a
      // 5-star rating into the visible asset.
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" && hasPrev) {
        onPrev();
        return;
      }
      if (e.key === "ArrowRight" && hasNext) {
        onNext();
        return;
      }
      if (e.key === "i") {
        setShowPanel((v) => !v);
        return;
      }
      // M8 — spacebar toggles the slideshow.
      if (e.key === " ") {
        e.preventDefault();
        setSlideshow((v) => !v);
        return;
      }
      if (e.key === "c") {
        setShowComments((v) => !v);
        return;
      }
      // Phase 3.4 — F toggles favorite, 0..5 sets rating.
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFavorite();
        return;
      }
      if (e.key >= "0" && e.key <= "5") {
        e.preventDefault();
        void mutateAsset({ rating: Number(e.key) });
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext, toggleFavorite, mutateAsset]);

  async function handleAddTag(tagId: string) {
    const res = await fetch(`/api/v1/assets/${asset.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId }),
    });
    if (res.ok) {
      const tag = allTags.find((t) => t.id === tagId);
      if (tag) setTags((prev) => [...prev, tag]);
    }
  }

  async function handleRemoveTag(tagId: string) {
    await fetch(`/api/v1/assets/${asset.id}/tags?tagId=${tagId}`, { method: "DELETE" });
    setTags((prev) => prev.filter((t) => t.id !== tagId));
  }

  async function handleCreateTag(name: string) {
    const res = await fetch("/api/v1/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = await res.json();
      const newTag = data.tag as TagItem;
      setAllTags((prev) => [...prev, newTag]);
      const res2 = await fetch(`/api/v1/assets/${asset.id}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId: newTag.id }),
      });
      if (res2.ok) setTags((prev) => [...prev, newTag]);
    }
  }

  async function handleAddToCollection(collectionId: string) {
    await fetch(`/api/v1/collections/${collectionId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: asset.id }),
    });
  }

  async function handleDownload() {
    // Phase 1.1 — the `url` state holds the 1080px preview variant for
    // on-screen rendering. Downloads must hit the original, so request a
    // fresh presigned URL explicitly for `variant=original`.
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}/url?variant=original`);
      const data = (await res.json()) as { url?: string };
      if (!res.ok || !data.url) {
        pushToast("error", "Download failed");
        return;
      }
      const a = document.createElement("a");
      a.href = data.url;
      a.download = asset.filename;
      a.click();
    } catch {
      pushToast("error", "Download failed");
    }
  }

  async function handleTrash() {
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trash: true }),
      });
      if (!res.ok) {
        pushToast("error", "Failed to move to trash");
        return;
      }
    } catch {
      pushToast("error", "Failed to move to trash");
      return;
    }
    // Only advance the UI once the server actually accepted the change.
    onTrash?.(asset.id);
    onClose();
  }

  async function handleShare() {
    // If link exists, copy it; otherwise generate.
    if (shareUrl) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      } catch {
        /* clipboard unavailable */
      }
      return;
    }
    setShareLoading(true);
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}/share`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { url: string };
        const fullUrl = `${window.location.origin}${data.url}`;
        setShareUrl(fullUrl);
        try {
          await navigator.clipboard.writeText(fullUrl);
          setShareCopied(true);
          setTimeout(() => setShareCopied(false), 2000);
        } catch {
          /* clipboard unavailable */
        }
      } else {
        pushToast("error", "Couldn't create share link");
      }
    } catch {
      pushToast("error", "Couldn't create share link");
    } finally {
      setShareLoading(false);
    }
  }

  async function handleRevokeShare() {
    await fetch(`/api/v1/assets/${asset.id}/share`, { method: "DELETE" });
    setShareUrl(null);
    setShareCopied(false);
  }

  // Task #33 — rotate in-place. POSTs to /transform with `asNew:false`,
  // bumps cacheBust so the displayed <img> refetches, toasts on result.
  const handleRotate = useCallback(
    async (deg: 90 | 180 | 270 | -90) => {
      if (transformBusy) return;
      setTransformBusy(true);
      try {
        const res = await fetch(`/api/v1/assets/${asset.id}/transform`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rotate: deg }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Re-fetch the preview URL — the same endpoint may return a fresh
        // presigned URL (and the worker is about to regenerate the
        // preview key), so we both reset the URL and bump the cache-bust.
        const fresh = await fetch(
          `/api/v1/assets/${asset.id}/url?variant=preview`
        );
        if (fresh.ok) {
          const data = (await fresh.json()) as { url?: string };
          setUrl(data.url ?? null);
        }
        setCacheBust((n) => n + 1);
        pushToast("success", "Rotated");
      } catch {
        pushToast("error", "Rotate failed");
      } finally {
        setTransformBusy(false);
      }
    },
    [asset.id, transformBusy, pushToast]
  );

  // Task #33 — open the crop modal. Seeds a centered 80% crop so the user
  // has something to drag. The actual selection is computed in onChange /
  // onComplete from react-image-crop.
  function openCropModal() {
    if (transformBusy) return;
    setCropValue(undefined);
    setCropPixel(undefined);
    setCropOpen(true);
  }

  // Compute the initial crop once the modal's <img> has loaded — react-
  // image-crop needs the rendered dimensions to position handles.
  function onCropImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    const initial = centerCrop(
      makeAspectCrop({ unit: "%", width: 80 }, width / height, width, height),
      width,
      height
    );
    setCropValue(initial);
    setCropPixel({
      unit: "px",
      x: (initial.x / 100) * width,
      y: (initial.y / 100) * height,
      width: (initial.width / 100) * width,
      height: (initial.height / 100) * height,
    });
  }

  // Task #33 — save the cropped copy. Converts the pixel selection to
  // normalised 0..1 against the displayed image, POSTs to /transform, and
  // navigates to the NEW asset on success.
  async function handleCropSave() {
    const img = cropImgRef.current;
    if (!img || !cropPixel || cropPixel.width < 1 || cropPixel.height < 1) {
      pushToast("error", "Drag a region to crop first");
      return;
    }
    setCropSaving(true);
    try {
      const dispW = img.width;
      const dispH = img.height;
      const x = Math.max(0, Math.min(1, cropPixel.x / dispW));
      const y = Math.max(0, Math.min(1, cropPixel.y / dispH));
      const w = Math.max(0, Math.min(1 - x, cropPixel.width / dispW));
      const h = Math.max(0, Math.min(1 - y, cropPixel.height / dispH));
      if (w <= 0 || h <= 0) {
        pushToast("error", "Crop region is empty");
        return;
      }
      const res = await fetch(`/api/v1/assets/${asset.id}/transform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crop: { x, y, w, h } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { assetId?: string };
      if (!data.assetId) throw new Error("Missing assetId in response");
      pushToast("success", "Saved cropped copy");
      setCropOpen(false);
      // Library is the canonical deep-link surface — `?lb=<id>` already
      // mounts the lightbox for a specific asset id (see the directAsset
      // fetch in app/library/page.tsx), and clears the current grid index.
      router.push(`/app/library?lb=${data.assetId}`);
    } catch {
      pushToast("error", "Crop failed");
    } finally {
      setCropSaving(false);
    }
  }

  // Phase 2 (faces/UX, #9) — ignore ("not a face") a single detected face.
  // PATCH the face hidden:true, then drop its chip optimistically.
  async function handleIgnoreFace(faceId: string) {
    setFaces((prev) => prev.filter((f) => f.id !== faceId));
    try {
      const res = await fetch(`/api/v1/faces/${faceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      // Re-fetch to restore the chip set on failure.
      fetch(`/api/v1/assets/${displayedAssetId}/faces`)
        .then((r) => (r.ok ? r.json() : { faces: [] }))
        .then((d: { faces?: LightboxFace[] }) => setFaces(d.faces ?? []))
        .catch(() => {});
    }
  }

  // #9 — ignore every face in this photo at once. PATCH the asset-level
  // faces-ignored flag, then clear all chips optimistically.
  async function handleIgnorePhotoFaces() {
    const snapshot = faces;
    setFaces([]);
    setShowNames(false);
    try {
      const res = await fetch(
        `/api/v1/assets/${displayedAssetId}/faces-ignored`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ignored: true }),
        }
      );
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      setFaces(snapshot);
    }
  }

  // Phase 2 (faces/UX) — map each normalized face bbox onto pixel coordinates
  // over the displayed <img>. The image is rendered object-contain, so the
  // actual picture is letterboxed inside the element rect: compute the content
  // box from the natural aspect ratio, then translate normalized bbox → px.
  // `imgRectTick` forces a recompute on load / resize / panel toggles.
  const faceChips = useMemo(() => {
    void imgRectTick; // dependency: recompute when the rect may have changed
    const el = imgRef.current;
    if (!el || faces.length === 0) return [];
    const natW = el.naturalWidth;
    const natH = el.naturalHeight;
    const boxW = el.clientWidth;
    const boxH = el.clientHeight;
    if (!natW || !natH || !boxW || !boxH) return [];
    // object-contain: scale to fit, centered.
    const scale = Math.min(boxW / natW, boxH / natH);
    const dispW = natW * scale;
    const dispH = natH * scale;
    const offX = (boxW - dispW) / 2;
    const offY = (boxH - dispH) / 2;
    // Chips are absolutely positioned against the `relative` wrapper, but the
    // <img> sits centered inside that wrapper's padding (p-8) + flex centering.
    // Add the img's offset within the wrapper so chips land on the face, not
    // shifted down/right by the padding + letterbox gap.
    const baseX = el.offsetLeft;
    const baseY = el.offsetTop;
    return faces
      .filter((f) => f.bbox)
      .map((f) => {
        const b = f.bbox!;
        return {
          id: f.id,
          name: f.personName,
          left: baseX + offX + b.x * dispW,
          top: baseY + offY + b.y * dispH,
          width: b.w * dispW,
          height: b.h * dispH,
        };
      });
  }, [faces, imgRectTick]);

  const hasNamedFace = faces.some((f) => f.personName);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95">
      {/* Top bar */}
      <div className="flex h-12 items-center justify-between gap-4 px-4 shrink-0 border-b border-white/10">
        <button
          onClick={onClose}
          className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Phase 3.4 — favorite + 5-star toolbar. Centered between the close
            button and the info toggle. Keyboard shortcuts: F toggles
            favorite, 1..5 set rating, 0 clears. */}
        <div className="flex items-center gap-3 min-w-0 flex-1 justify-center">
          <button
            onClick={toggleFavorite}
            className={`rounded-full p-1.5 transition-colors shrink-0 ${
              isFavorite
                ? "text-red-400 bg-white/10 hover:bg-white/15"
                : "text-white/60 hover:text-white hover:bg-white/10"
            }`}
            title={isFavorite ? "Unfavorite (F)" : "Favorite (F)"}
            aria-label={isFavorite ? "Unfavorite" : "Favorite"}
            aria-pressed={isFavorite}
          >
            <Heart className="h-5 w-5" fill={isFavorite ? "currentColor" : "none"} />
          </button>
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => {
              const active = n <= rating;
              return (
                <button
                  key={n}
                  onClick={() => setRatingValue(n)}
                  className={`p-1 transition-colors ${
                    active
                      ? "text-yellow-400 hover:text-yellow-300"
                      : "text-white/30 hover:text-white/70"
                  }`}
                  title={`Rate ${n}/5 (${n})`}
                  aria-label={`Rate ${n} out of 5`}
                  aria-checked={rating === n}
                  role="radio"
                >
                  <Star className="h-4 w-4" fill={active ? "currentColor" : "none"} />
                </button>
              );
            })}
          </div>
          <p className="text-sm text-white/70 truncate max-w-xs" title={asset.filename}>
            {asset.filename}
          </p>
        </div>

        {/* Task #33 — rotate + crop cluster. Images only; hidden for video /
            text / cross-workspace shares (the recipient doesn't own pixels). */}
        {asset.mimeType.startsWith("image/") && !asset.sharedFrom && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => void handleRotate(-90)}
              disabled={transformBusy}
              className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="Rotate 90° counter-clockwise"
              aria-label="Rotate 90 degrees counter-clockwise"
            >
              <RotateCcw className="h-5 w-5" />
            </button>
            <button
              onClick={() => void handleRotate(90)}
              disabled={transformBusy}
              className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="Rotate 90° clockwise"
              aria-label="Rotate 90 degrees clockwise"
            >
              <RotateCw className="h-5 w-5" />
            </button>
            <button
              onClick={() => void handleRotate(180)}
              disabled={transformBusy}
              className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="Rotate 180°"
              aria-label="Rotate 180 degrees"
            >
              <FlipVertical className="h-5 w-5" />
            </button>
            <button
              onClick={openCropModal}
              disabled={transformBusy}
              className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title="Crop & save copy"
              aria-label="Crop and save a copy"
            >
              <CropIcon className="h-5 w-5" />
            </button>
            {transformBusy && (
              <Loader2 className="h-4 w-4 animate-spin text-white/60" />
            )}
          </div>
        )}

        {/* Task #33 — "Derived from" badge when this asset was produced by
            /transform. Click jumps to the source asset via the library's
            ?lb=<id> deep-link. */}
        {asset.derivedFromAssetId && (
          <button
            onClick={() =>
              router.push(`/app/library?lb=${asset.derivedFromAssetId}`)
            }
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20 hover:text-white transition-colors shrink-0"
            title="Open the original this copy was derived from"
          >
            <CornerUpLeft className="h-3 w-3" />
            Derived
          </button>
        )}

        {/* Phase 7b — share to another workspace. Hidden when the asset
            is being rendered through someone else's share (recipients
            can't re-share onward). */}
        {!asset.sharedFrom && asset.workspaceId && (
          <AssetWorkspaceShare assetId={asset.id} sourceWorkspaceId={asset.workspaceId} />
        )}
        {/* M8 — slideshow play/pause. Disabled at the end of the list. */}
        <button
          onClick={() => setSlideshow((v) => !v)}
          disabled={!slideshow && !hasNext}
          className={`rounded-full p-1.5 transition-colors shrink-0 disabled:opacity-40 ${
            slideshow ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title={slideshow ? "Pause slideshow (space)" : "Play slideshow (space)"}
          aria-label={slideshow ? "Pause slideshow" : "Play slideshow"}
          aria-pressed={slideshow}
        >
          {slideshow ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </button>
        <button
          onClick={() => setShowComments((v) => !v)}
          className={`rounded-full p-1.5 transition-colors shrink-0 ${
            showComments ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Toggle comments (c)"
        >
          <MessageCircle className="h-5 w-5" />
        </button>
        <button
          onClick={() => setShowPanel((v) => !v)}
          className={`rounded-full p-1.5 transition-colors shrink-0 ${
            showPanel ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Toggle info panel (i)"
        >
          <Info className="h-5 w-5" />
        </button>
      </div>

      {/* Main area */}
      <div className="relative flex flex-1 min-h-0">
        {/* Photo area — clicking the black space around the image (but not
            the image, nav arrows, or stack chip) closes the lightbox. */}
        <div
          className="flex flex-1 items-center justify-center relative min-w-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {hasPrev && (
            <button
              onClick={onPrev}
              className="absolute left-4 z-10 rounded-full p-2 bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={onNext}
              className="absolute right-4 z-10 rounded-full p-2 bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
          {isTextLike(asset.mimeType) ? (
            <TextViewer
              content={textContent}
              loading={textLoading}
              code={isCodeLike(asset.mimeType)}
              filename={asset.filename}
            />
          ) : asset.mimeType.startsWith("video/") ? (
            // Phase 8b — HLS playback. The preview URL doubles as a
            // poster so the user sees the 10%-mark thumbnail (from
            // 8a) while the transcode completes on first play.
            <VideoPlayer
              assetId={displayedAssetId}
              durationSec={asset.durationSeconds ?? null}
              posterUrl={url}
            />
          ) : urlLoading ? (
            <Loader2 className="h-10 w-10 animate-spin text-white/40" />
          ) : url ? (
            // Phase 2 (faces/UX) — the image is wrapped so name-tag chips can
            // be absolutely positioned over each detected face. Tapping the
            // image toggles the chips (mirrors the Flutter `_showNames`).
            <div
              className="relative flex max-h-full max-w-full items-center justify-center p-8"
              onMouseEnter={showMotion ? () => void startMotion() : undefined}
              onMouseLeave={showMotion ? stopMotion : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                // Task #33 — `cacheBust` is bumped after an in-place rotate
                // so the browser refetches even when the presigned URL is
                // byte-identical. Append `?v=N` (or `&v=N` if the URL
                // already carries a query string).
                src={cacheBust > 0 ? `${url}${url.includes("?") ? "&" : "?"}v=${cacheBust}` : url}
                alt={asset.description ?? asset.filename}
                className={`max-h-full max-w-full object-contain ${
                  faces.length > 0 ? "cursor-pointer" : ""
                }`}
                onLoad={() => setImgRectTick((t) => t + 1)}
                onClick={() => {
                  if (faces.length > 0) setShowNames((v) => !v);
                }}
              />
              {/* M12 / ADR 0014 — motion clip overlay. Plays muted + looped
                  over the still while hovered (desktop) or toggled (touch). */}
              {showMotion && motionActive && motionUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  ref={motionVideoRef}
                  src={motionUrl}
                  muted
                  loop
                  autoPlay
                  playsInline
                  className="pointer-events-none absolute inset-0 m-auto max-h-full max-w-full object-contain p-8"
                />
              )}
              {/* "LIVE" badge — also the tap target for touch playback. */}
              {showMotion && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (motionActive) stopMotion();
                    else void startMotion();
                  }}
                  className="absolute left-4 top-4 z-10 flex items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white hover:bg-black/80"
                  title={motionActive ? "Stop Live Photo" : "Play Live Photo"}
                  aria-label={motionActive ? "Stop Live Photo" : "Play Live Photo"}
                >
                  <CircleDot className="h-3 w-3" />
                  Live
                </button>
              )}
              {showNames &&
                faceChips.map((c) => (
                  <div
                    key={c.id}
                    className="absolute rounded-sm border border-white/70 ring-1 ring-black/40"
                    style={{
                      left: `${c.left}px`,
                      top: `${c.top}px`,
                      width: `${c.width}px`,
                      height: `${c.height}px`,
                    }}
                  >
                    {c.name && (
                      <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/80 px-2 py-0.5 text-[11px] font-medium text-white shadow">
                        {c.name}
                      </span>
                    )}
                    {/* #9 — per-face "not a face" ignore. Small × in the
                        bbox corner; stops propagation so it doesn't toggle
                        the names overlay. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleIgnoreFace(c.id);
                      }}
                      className="absolute -right-2 -top-2 rounded-full bg-black/80 p-1 text-white/90 hover:bg-black hover:text-white"
                      title="Ignore this face (not a face)"
                      aria-label="Ignore this face"
                    >
                      <EyeOff className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              {/* Hint chip when faces exist but names are hidden. */}
              {faces.length > 0 && !showNames && hasNamedFace && (
                <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/80">
                  Tap photo to show names
                </span>
              )}
              {/* #9 — photo-level "ignore all faces here" control, shown
                  while the names overlay is open. */}
              {showNames && faces.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleIgnorePhotoFaces();
                  }}
                  className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-[11px] font-medium text-white hover:bg-black/85"
                  title="Ignore every face in this photo"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ignore faces in this photo
                </button>
              )}
            </div>
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-white/5">
              <Tag className="h-16 w-16 text-white/20" />
            </div>
          )}

          {/* Phase 5.5 — stack indicator. Bottom-left, only when the asset
              belongs to a stack. Click to toggle inline carousel of all
              members (members lazy-loaded on first open). */}
          {stackId && (
            <div className="absolute bottom-4 left-4 z-10 flex flex-col items-start gap-2">
              <button
                onClick={toggleStack}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  stackOpen
                    ? "bg-white text-black"
                    : "bg-black/70 text-white hover:bg-black/85"
                }`}
                title={stackOpen ? "Collapse stack" : "Expand stack"}
                aria-expanded={stackOpen}
              >
                <Layers className="h-3.5 w-3.5" />
                {stackLoading
                  ? "Stack…"
                  : stackMembers
                  ? `Stack of ${stackMembers.length}`
                  : "Stack"}
              </button>
              {stackOpen && stackMembers && stackMembers.length > 0 && (
                <div className="flex max-w-[60vw] gap-1.5 overflow-x-auto rounded-md bg-black/50 p-1.5">
                  {stackMembers.map((m) => (
                    <StackThumb
                      key={m.id}
                      asset={m}
                      active={m.id === displayedAssetId}
                      onClick={() =>
                        setViewMemberId(m.id === asset.id ? null : m.id)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Metadata panel */}
        {showPanel && (
          <MetadataPanel
            asset={asset}
            tags={tags}
            allTags={allTags}
            collections={collections}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onCreateTag={handleCreateTag}
            onAddToCollection={handleAddToCollection}
            onDownload={handleDownload}
            onTrash={handleTrash}
            onShare={handleShare}
            shareState={{ url: shareUrl, copied: shareCopied, loading: shareLoading }}
            onRevokeShare={handleRevokeShare}
            onOpenShareDialog={() => setShareDialogOpen(true)}
            onOpenSimilar={(id) => setViewMemberId(id === asset.id ? null : id)}
          />
        )}
        {showComments && (
          <CommentsPanel
            assetId={asset.id}
            currentUserId={currentUserId}
            canModerate={false}
          />
        )}
      </div>
      <ShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        targetType="asset"
        targetId={asset.id}
      />

      {/* Task #33 — crop modal. Loads the same preview URL we display in the
          main area, draws react-image-crop on top, posts a normalised 0..1
          rect to /transform on save. */}
      <Dialog
        open={cropOpen}
        onOpenChange={(open) => {
          if (!cropSaving) setCropOpen(open);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Crop & save copy</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] items-center justify-center overflow-auto rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container)] p-2">
            {url ? (
              <ReactCrop
                crop={cropValue}
                onChange={(pixel, percent) => {
                  setCropValue(percent);
                  setCropPixel(pixel);
                }}
                keepSelection
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={cropImgRef}
                  src={url}
                  alt={asset.filename}
                  onLoad={onCropImageLoad}
                  className="max-h-[60vh] max-w-full object-contain"
                />
              </ReactCrop>
            ) : (
              <Loader2 className="h-8 w-8 animate-spin text-[var(--ft-color-on-surface-variant)]" />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="text"
              onClick={() => setCropOpen(false)}
              disabled={cropSaving}
            >
              Cancel
            </Button>
            <Button
              variant="tonal"
              onClick={() => void handleCropSave()}
              disabled={cropSaving || !cropPixel || cropPixel.width < 1}
            >
              {cropSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save copy"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #33 — bottom-right toast stack. */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto rounded-[var(--ft-shape-medium)] px-4 py-2 text-sm shadow-[var(--ft-elev-2)] ${
                t.kind === "success"
                  ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                  : "bg-[var(--ft-color-error-container)] text-[var(--ft-color-on-error-container)]"
              }`}
              role={t.kind === "error" ? "alert" : "status"}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Phase 6.12 — renders the extracted text layer for text/code assets in a
// scrollable monospace panel. `code` files (markdown / source) get a tighter
// line height and a faint editor-like background; plain text reads as prose.
function TextViewer({
  content,
  loading,
  code,
  filename,
}: {
  content: string | null;
  loading: boolean;
  code: boolean;
  filename: string;
}) {
  if (loading) {
    return <Loader2 className="h-10 w-10 animate-spin text-white/40" />;
  }
  if (!content) {
    return (
      <div className="flex flex-col items-center gap-3 text-white/40">
        <Tag className="h-12 w-12" />
        <p className="text-sm">No text content extracted</p>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full max-w-3xl flex-col p-6 sm:p-10">
      <p className="mb-3 shrink-0 truncate font-mono text-xs text-white/50" title={filename}>
        {filename}
      </p>
      <pre
        className={`flex-1 overflow-auto rounded-lg border border-white/10 bg-white/5 p-4 font-mono text-white/90 ${
          code ? "text-[13px] leading-snug" : "text-sm leading-relaxed whitespace-pre-wrap"
        }`}
      >
        {content}
      </pre>
    </div>
  );
}

// Phase 5.5 — small thumbnail used inside the stack carousel. Fetches the
// 256px grid variant via the same `?variant=thumb` endpoint the photo
// cards use. Clicks swap the displayed image in the lightbox (handled by
// the parent via viewMemberId); metadata panel + favorite / rating /
// share stay keyed to the stack's primary asset.
function StackThumb({
  asset,
  active,
  onClick,
}: {
  asset: Asset;
  active: boolean;
  onClick?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) return;
    fetch(`/api/v1/assets/${asset.id}/url?variant=thumb`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => setSrc(d?.url ?? null))
      .catch(() => setSrc(null));
  }, [asset.id, asset.mimeType]);
  return (
    <button
      onClick={onClick}
      className={`relative h-14 w-14 shrink-0 overflow-hidden rounded transition-all ${
        active ? "ring-2 ring-white" : "ring-1 ring-white/20 hover:ring-white/60"
      }`}
      title={asset.filename}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={asset.filename} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white/10">
          <Layers className="h-4 w-4 text-white/40" />
        </div>
      )}
    </button>
  );
}
