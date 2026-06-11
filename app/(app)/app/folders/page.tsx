// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.5 — Folder view (UX-3 sweep + N+1 fix).
//
// Browse uploads by virtual directory path (Immich-style). The page
// adopts AssetPageToolbar / AssetGrid; the breadcrumb + child-folder
// row stays bespoke because folders aren't asset cards.
//
// N+1 fix (audit §UX-4): the old version fetched the ENTIRE asset list
// on every folder click and filtered client-side. Now the list endpoint
// gains ?directoryPath=<exact> so a folder click hits a single indexed
// query.
//
// URL-driven so back/forward and deep-linking work naturally:
//   /app/folders             -> root (workspace top level)
//   /app/folders?path=/Photos
//   /app/folders?path=/Photos/2024/Iceland

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Folder as FolderIcon,
  Home,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
  ArrowRight,
} from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { FolderTree } from "../_components/folder-tree";
import { ListErrorState } from "../_components/list-states";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { cn } from "@/lib/utils";

interface FolderEntry {
  name: string;
  path: string;
  assetCount: number;
}
interface FolderListing {
  prefix: string;
  folders: FolderEntry[];
  assetsAtThisLevel: number;
}

function folderHref(path: string): string {
  if (!path || path === "/") return "/app/folders";
  return `/app/folders?path=${encodeURIComponent(path)}`;
}

function parentOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  segs.pop();
  return segs.length === 0 ? "" : "/" + segs.join("/");
}

function Breadcrumb({ prefix }: { prefix: string }) {
  const segments = prefix.split("/").filter(Boolean);
  const accumulated: { name: string; path: string }[] = [];
  let acc = "";
  for (const seg of segments) {
    acc += "/" + seg;
    accumulated.push({ name: seg, path: acc });
  }

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <Link
        href="/app/folders"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
      >
        <Home className="h-3.5 w-3.5" />
        Root
      </Link>
      {accumulated.map((seg, i) => {
        const isLast = i === accumulated.length - 1;
        return (
          <span key={seg.path} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <Link
              href={folderHref(seg.path)}
              className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors ${
                isLast ? "text-foreground font-medium" : ""
              }`}
            >
              {seg.name}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}

function FolderCard({
  folder,
  busy,
  dropTarget,
  onAction,
  onAssetDrop,
  onDragOverChange,
}: {
  folder: FolderEntry;
  busy: boolean;
  dropTarget: boolean;
  onAction: (action: "rename" | "move" | "delete", folder: FolderEntry) => void;
  onAssetDrop: (folder: FolderEntry, assetId: string) => void;
  onDragOverChange: (folderPath: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-lg border bg-card px-3 py-3 transition-colors hover:bg-muted",
        dropTarget ? "border-primary ring-2 ring-primary" : "border-border",
        busy && "opacity-50 pointer-events-none"
      )}
      onDragOver={(e) => {
        // Accept drops from PhotoCard (asset-id MIME types).
        if (e.dataTransfer.types.includes("application/x-fonto-asset")) {
          e.preventDefault();
          onDragOverChange(folder.path);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the card itself, not a child element.
        if (e.currentTarget === e.target) onDragOverChange(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverChange(null);
        const assetId = e.dataTransfer.getData("application/x-fonto-asset");
        if (assetId) onAssetDrop(folder, assetId);
      }}
    >
      <Link href={folderHref(folder.path)} className="flex flex-1 items-center gap-3 min-w-0">
        <FolderIcon className="h-8 w-8 shrink-0 text-primary-text" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {folder.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {folder.assetCount} {folder.assetCount === 1 ? "item" : "items"}
          </p>
        </div>
      </Link>
      <div ref={menuRef} className="relative">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="opacity-0 group-hover:opacity-100 rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground transition-opacity"
          aria-label={`Actions for ${folder.name}`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-8 z-20 min-w-36 rounded-lg border border-border bg-popover shadow-lg py-1">
            <button
              onClick={() => {
                setMenuOpen(false);
                onAction("rename", folder);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onAction("move", folder);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Move…
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onAction("delete", folder);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-muted transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FoldersContent() {
  const searchParams = useSearchParams();
  const prefix = searchParams.get("path") ?? "";

  const toolbar = useToolbarState({
    page: "folders",
    availableFilters: ["mime", "type", "favorite", "ratingMin"],
  });

  const [state, setState] = useState<{
    loadedPrefix: string | null;
    listing: FolderListing | null;
    assets: Asset[];
  }>({ loadedPrefix: null, listing: null, assets: [] });
  const [loadError, setLoadError] = useState(false);
  const loading = state.loadedPrefix !== prefix && !loadError;
  const listing = state.loadedPrefix === prefix ? state.listing : null;
  const assets = state.loadedPrefix === prefix ? state.assets : [];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // UX-2 — per-folder org ops. busyFolders gates input on the matching
  // FolderCard so a rename/move/delete doesn't fire twice. dropTarget
  // highlights the card the user is hovering an asset over.
  const [busyFolders, setBusyFolders] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);

    const folderUrl = prefix
      ? `/api/v1/folders?prefix=${encodeURIComponent(prefix)}`
      : "/api/v1/folders";

    // Server-side ?directoryPath filter replaces the previous fetch-all-
    // then-filter pattern. Root (prefix === "") becomes directoryPath="/"
    // which the endpoint maps to IS NULL.
    const assetUrl = new URL("/api/v1/assets", window.location.origin);
    assetUrl.searchParams.set("directoryPath", prefix || "/");
    if (toolbar.filters.mime) assetUrl.searchParams.set("mime", toolbar.filters.mime);
    if (toolbar.filters.type) assetUrl.searchParams.set("subtype", toolbar.filters.type);
    if (toolbar.filters.favorite) assetUrl.searchParams.set("favorite", "1");
    if (toolbar.filters.ratingMin != null)
      assetUrl.searchParams.set("ratingMin", String(toolbar.filters.ratingMin));

    Promise.all([
      fetch(folderUrl).then((r) => {
        if (!r.ok) throw new Error(`folders ${r.status}`);
        return r.json() as Promise<FolderListing>;
      }),
      fetch(assetUrl.toString()).then((r) => {
        if (!r.ok) throw new Error(`assets ${r.status}`);
        return r.json().then((d) => (d.assets ?? []) as Asset[]);
      }),
    ])
      .then(([folderData, assetData]) => {
        if (cancelled) return;
        let list = assetData;
        if (toolbar.filters.q) {
          const needle = toolbar.filters.q.toLowerCase();
          list = list.filter(
            (a) =>
              a.filename.toLowerCase().includes(needle) ||
              (a.description?.toLowerCase().includes(needle) ?? false)
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
        }
        setState({
          loadedPrefix: prefix,
          listing: folderData,
          assets: list,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setState({
          loadedPrefix: prefix,
          listing: { prefix, folders: [], assetsAtThisLevel: 0 },
          assets: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    prefix,
    toolbar.filters.mime,
    toolbar.filters.type,
    toolbar.filters.favorite,
    toolbar.filters.ratingMin,
    toolbar.filters.q,
    toolbar.filters.sort,
    reloadKey,
  ]);

  // UX-2 — folder ops. The folder operation endpoint mutates the
  // matching subtree; on success we reload the current listing so the
  // child folder either disappears (delete), renames in place, or moves
  // out of view. The current URL prefix stays the same — the parent
  // folder didn't move.
  const runOp = useCallback(
    async (
      action: "rename" | "move" | "delete",
      folder: FolderEntry
    ) => {
      let payload: Record<string, unknown> | null = null;
      if (action === "rename") {
        const next = window.prompt(
          `Rename "${folder.name}" to:`,
          folder.name
        );
        if (!next || next === folder.name) return;
        payload = { op: "rename", path: folder.path, newName: next };
      } else if (action === "move") {
        const next = window.prompt(
          `Move "${folder.path}" under (parent path, blank for root):`,
          parentOf(folder.path)
        );
        if (next === null) return;
        payload = { op: "move", path: folder.path, newParent: next };
      } else {
        const ok = window.confirm(
          `Delete "${folder.name}" — move every asset under it to Trash?\n\n` +
            "Choose Cancel to keep the assets but drop the folder tag."
        );
        const actionMode = ok ? "trash" : "orphan";
        const confirmAgain = window.confirm(
          actionMode === "trash"
            ? `Trash everything in "${folder.name}"?`
            : `Move every asset out of "${folder.name}" to the root?`
        );
        if (!confirmAgain) return;
        payload = { op: "delete", path: folder.path, action: actionMode };
      }

      setBusyFolders((prev) => {
        const next = new Set(prev);
        next.add(folder.path);
        return next;
      });
      try {
        const r = await fetch("/api/v1/folders/operation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          window.alert(`Folder op failed: ${body.error ?? r.status}`);
          return;
        }
        reload();
      } finally {
        setBusyFolders((prev) => {
          const next = new Set(prev);
          next.delete(folder.path);
          return next;
        });
      }
    },
    [reload]
  );

  // Drag-drop: PATCH the dropped asset's directoryPath to the target
  // folder. Triggers a reload so the asset disappears from the current
  // listing (which is filtered to the current prefix).
  const handleAssetDrop = useCallback(
    async (folder: FolderEntry, assetId: string) => {
      try {
        const r = await fetch(`/api/v1/assets/${assetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directoryPath: folder.path }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          window.alert(`Move failed: ${body.error ?? r.status}`);
          return;
        }
        reload();
      } catch {
        window.alert("Network error during move");
      }
    },
    [reload]
  );

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  const visibleTitle = prefix
    ? prefix.split("/").filter(Boolean).pop() ?? "Folders"
    : "Folders";

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      <FolderTree
        currentPath={prefix}
        onAssetDrop={(folderPath, assetId) =>
          handleAssetDrop(
            { name: folderPath.split("/").filter(Boolean).pop() ?? "", path: folderPath, assetCount: 0 },
            assetId
          )
        }
      />
      <div className="flex-1 min-w-0 space-y-3">
      <AssetPageToolbar
        title={visibleTitle}
        count={loading ? undefined : (listing?.folders.length ?? 0) + assets.length}
        toolbar={toolbar}
        searchPlaceholder="Search this folder…"
        sortOptions={["newest", "oldest", "name"]}
        filterKeys={["mime", "type", "favorite", "ratingMin"]}
        showDensity
        showSelect
      />

      <div className="px-4 space-y-5">
        <Breadcrumb prefix={listing?.prefix ?? prefix} />

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading folder…
          </div>
        ) : loadError ? (
          <ListErrorState
            message="Couldn't load this folder. Check your connection and retry."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : (
          <>
            {listing && listing.folders.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Folders
                </h2>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {listing.folders.map((f) => (
                    <FolderCard
                      key={f.path}
                      folder={f}
                      busy={busyFolders.has(f.path)}
                      dropTarget={dropTarget === f.path}
                      onAction={runOp}
                      onAssetDrop={handleAssetDrop}
                      onDragOverChange={setDropTarget}
                    />
                  ))}
                </div>
              </section>
            )}

            {assets.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {assets.length} {assets.length === 1 ? "item" : "items"} at
                  this level
                </h2>
                <AssetGrid
                  assets={assets}
                  toolbar={toolbar}
                  viewMode="grid"
                  onAssetClick={(_id, index) => setLightboxIndex(index)}
                />
              </section>
            )}

            {listing &&
              listing.folders.length === 0 &&
              assets.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <ImageIcon className="h-10 w-10 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground max-w-md">
                    This folder is empty. Uploads carry their source directory
                    via the <code className="text-foreground">X-Fonto-Path</code>{" "}
                    header (multipart), the <code className="text-foreground">path</code>{" "}
                    field on <code className="text-foreground">/assets/init</code>,
                    or <code className="text-foreground">metadata.path</code> on tus.
                  </p>
                </div>
              )}
          </>
        )}
      </div>

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <PhotoLightbox
          asset={assets[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => navLightbox(-1)}
          onNext={() => navLightbox(1)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < assets.length - 1}
        />
      )}
      </div>
    </div>
  );
}

export default function FoldersPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <FoldersContent />
    </Suspense>
  );
}
