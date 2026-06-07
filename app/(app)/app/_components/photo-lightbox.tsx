// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  X, ChevronLeft, ChevronRight, Info, Tag, FolderPlus, Download,
  Trash2, Plus, Loader2, Share2, Check, Copy, Settings, Heart, Star, Layers, MessageCircle,
  ScanSearch, EyeOff
} from "lucide-react";
import type { Asset } from "./photo-card";
import { ConfirmButton } from "@/components/confirm-button";
import { ShareDialog } from "./share-dialog";
import { CommentsPanel } from "./comments-panel";
import { AssetWorkspaceShare } from "./asset-workspace-share";
import { VideoPlayer } from "./video-player";
import { useSession } from "@/lib/auth/client";

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
}: MetadataPanelProps) {
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showCollections, setShowCollections] = useState(false);
  const [rescanState, setRescanState] = useState<"idle" | "loading" | "done">("idle");
  const tagInputRef = useRef<HTMLInputElement>(null);
  const colRef = useRef<HTMLDivElement>(null);

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
    <div className="absolute inset-y-0 right-0 z-30 w-full max-w-sm shrink-0 overflow-y-auto border-l border-border bg-card text-sm sm:static sm:inset-auto sm:z-auto sm:w-72 sm:max-w-none">
      <div className="p-4 space-y-5">
        {/* DETAILS */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Details</p>
          <div className="space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground text-xs shrink-0">Filename</span>
              <span className="text-xs text-foreground text-right truncate max-w-36" title={asset.filename}>{asset.filename}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground text-xs shrink-0">Size</span>
              <span className="text-xs text-foreground">{formatBytes(asset.sizeBytes)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground text-xs shrink-0">Captured</span>
              <span className="text-xs text-foreground">{formatDate(asset.capturedAt)}</span>
            </div>
            {asset.classification && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground text-xs shrink-0">Type</span>
                <span className="text-xs text-foreground capitalize">{asset.classification}</span>
              </div>
            )}
            {(() => {
              const w = asset.widthPx ?? asset.videoWidth;
              const h = asset.heightPx ?? asset.videoHeight;
              return w && h ? (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground text-xs shrink-0">Dimensions</span>
                  <span className="text-xs text-foreground">{w} × {h}</span>
                </div>
              ) : null;
            })()}
            {asset.pageCount != null && asset.pageCount > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground text-xs shrink-0">Pages</span>
                <span className="text-xs text-foreground">{asset.pageCount}</span>
              </div>
            )}
            {asset.durationSeconds != null && asset.durationSeconds > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground text-xs shrink-0">Duration</span>
                <span className="text-xs text-foreground">
                  {Math.floor(asset.durationSeconds / 60)}:
                  {String(Math.round(asset.durationSeconds % 60)).padStart(2, "0")}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* DESCRIPTION */}
        {asset.description && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Description</p>
            <p className="text-xs text-foreground leading-relaxed">{asset.description}</p>
          </div>
        )}

        {/* TAGS */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => onRemoveTag(tag.id)}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-foreground hover:bg-destructive/20 hover:text-destructive transition-colors"
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
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
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
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {unassignedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {unassignedTags.slice(0, 6).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { onAddTag(t.id); setAddingTag(false); setTagInput(""); }}
                        className="rounded-full px-2 py-0.5 text-[10px] bg-muted text-foreground hover:bg-primary/10 hover:text-primary transition-colors"
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

        {/* ACTIONS */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Actions</p>
          <div className="space-y-1.5">
            {/* Add to Collection dropdown */}
            <div ref={colRef} className="relative">
              <button
                onClick={() => setShowCollections((v) => !v)}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
                Add to Collection
                <ChevronLeft className={`h-3 w-3 ml-auto text-muted-foreground transition-transform ${showCollections ? "-rotate-90" : "rotate-90"}`} />
              </button>
              {showCollections && collections.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-lg border border-border bg-popover shadow-lg py-1 max-h-36 overflow-y-auto">
                  {collections.map((col) => (
                    <button
                      key={col.id}
                      onClick={() => { onAddToCollection(col.id); setShowCollections(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                    >
                      {col.name}
                    </button>
                  ))}
                </div>
              )}
              {showCollections && collections.length === 0 && (
                <div className="absolute top-full left-0 right-0 z-20 mt-1 rounded-lg border border-border bg-popover shadow-lg py-2 px-3">
                  <p className="text-xs text-muted-foreground">No collections yet</p>
                </div>
              )}
            </div>
            <button
              onClick={onDownload}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
              Download
            </button>
            {/* Re-scan — re-run the full recognition pipeline (OCR, labels,
                description, faces) on the local vision/Ollama box. */}
            <button
              onClick={handleRescan}
              disabled={rescanState === "loading"}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {rescanState === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : rescanState === "done" ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {rescanState === "done" ? "Re-scan queued" : "Re-scan (AI)"}
            </button>
            {/* Share */}
            <button
              onClick={onShare}
              disabled={shareState.loading}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {shareState.copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
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
              <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px]">
                <code className="flex-1 truncate font-mono text-muted-foreground">
                  {shareState.url}
                </code>
                <button
                  onClick={onShare}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  title="Copy"
                >
                  {shareState.copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
                <button
                  onClick={onRevokeShare}
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  title="Revoke link"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {/* Phase 2.5 — full share management (password, downloads, views). */}
            <button
              onClick={onOpenShareDialog}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              Manage share links…
            </button>
            <ConfirmButton
              onConfirm={() => onTrash?.()}
              className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-background px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
              armedClassName="bg-destructive/15 ring-1 ring-destructive"
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

  useEffect(() => {
    setIsFavorite(!!asset.isFavorite);
    setRating(asset.rating ?? 0);
    // Reset stack expansion when the visible asset changes.
    setStackMembers(null);
    setStackOpen(false);
    setViewMemberId(null);
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
    fetch("/api/v1/tags")
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => setAllTags(d.tags ?? []))
      .catch(() => setAllTags([]));
    fetch("/api/v1/collections")
      .then((r) => r.json())
      .then((d) => setCollections(d.collections ?? []));
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
      if (!data.url) return;
      const a = document.createElement("a");
      a.href = data.url;
      a.download = asset.filename;
      a.click();
    } catch {
      /* swallow */
    }
  }

  async function handleTrash() {
    await fetch(`/api/v1/assets/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trash: true }),
    });
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
      }
    } finally {
      setShareLoading(false);
    }
  }

  async function handleRevokeShare() {
    await fetch(`/api/v1/assets/${asset.id}/share`, { method: "DELETE" });
    setShareUrl(null);
    setShareCopied(false);
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

        {/* Phase 7b — share to another workspace. Hidden when the asset
            is being rendered through someone else's share (recipients
            can't re-share onward). */}
        {!asset.sharedFrom && asset.workspaceId && (
          <AssetWorkspaceShare assetId={asset.id} sourceWorkspaceId={asset.workspaceId} />
        )}
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
            <div className="relative flex max-h-full max-w-full items-center justify-center p-8">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={url}
                alt={asset.description ?? asset.filename}
                className={`max-h-full max-w-full object-contain ${
                  faces.length > 0 ? "cursor-pointer" : ""
                }`}
                onLoad={() => setImgRectTick((t) => t + 1)}
                onClick={() => {
                  if (faces.length > 0) setShowNames((v) => !v);
                }}
              />
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
