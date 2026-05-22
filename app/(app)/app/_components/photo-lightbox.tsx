// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef } from "react";
import {
  X, ChevronLeft, ChevronRight, Info, Tag, FolderPlus, Download,
  Trash2, Plus, Loader2, Share2, Check, Copy
} from "lucide-react";
import type { Asset } from "./photo-card";
import { ConfirmButton } from "@/components/confirm-button";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
}: MetadataPanelProps) {
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showCollections, setShowCollections] = useState(false);
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
    <div className="w-72 shrink-0 border-l border-border bg-card overflow-y-auto text-sm">
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
}

export function PhotoLightbox({
  asset,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onTrash,
}: PhotoLightboxProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(true);
  const [showPanel, setShowPanel] = useState(false);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [allTags, setAllTags] = useState<TagItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);

  useEffect(() => {
    setUrl(null);
    setUrlLoading(true);
    // Phase 1.1 — lightbox renders the 1080px preview variant. Falls back to
    // original on the server side if the derivative is missing.
    fetch(`/api/v1/assets/${asset.id}/url?variant=preview`)
      .then((r) => r.json())
      .then((d) => setUrl(d.url ?? null))
      .catch(() => setUrl(null))
      .finally(() => setUrlLoading(false));
  }, [asset.id]);

  useEffect(() => {
    fetch(`/api/v1/assets/${asset.id}/tags`)
      .then((r) => r.json())
      .then((d) => setTags(d.tags ?? []));
    fetch("/api/v1/tags")
      .then((r) => r.json())
      .then((d) => setAllTags(d.tags ?? []));
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) onPrev();
      if (e.key === "ArrowRight" && hasNext) onNext();
      if (e.key === "i") setShowPanel((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

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

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95">
      {/* Top bar */}
      <div className="flex h-12 items-center justify-between px-4 shrink-0 border-b border-white/10">
        <button
          onClick={onClose}
          className="rounded-full p-1.5 text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
        <p className="text-sm text-white/70 truncate max-w-xs">{asset.filename}</p>
        <button
          onClick={() => setShowPanel((v) => !v)}
          className={`rounded-full p-1.5 transition-colors ${
            showPanel ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Toggle info panel (i)"
        >
          <Info className="h-5 w-5" />
        </button>
      </div>

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Photo area */}
        <div className="flex flex-1 items-center justify-center relative min-w-0">
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
          {urlLoading ? (
            <Loader2 className="h-10 w-10 animate-spin text-white/40" />
          ) : url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={asset.description ?? asset.filename}
              className="max-h-full max-w-full object-contain p-8"
            />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-white/5">
              <Tag className="h-16 w-16 text-white/20" />
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
          />
        )}
      </div>
    </div>
  );
}
