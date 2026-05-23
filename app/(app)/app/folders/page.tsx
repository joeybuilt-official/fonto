// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.5 — Folder view.
//
// Browse uploads by their virtual directory path (Immich-style). Folders are
// computed at read time from `assets.directory_path` prefixes by
// `/api/v1/folders`; this page renders the listing + the assets that live
// exactly at the current prefix.
//
// URL-driven so back/forward and deep-linking work naturally:
//   /app/folders             -> root (workspace top level)
//   /app/folders?path=/Photos
//   /app/folders?path=/Photos/2024/Iceland
"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Folder as FolderIcon, Home, Image as ImageIcon, Loader2 } from "lucide-react";
import { PhotoCard, type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";

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

/**
 * Render a click-through breadcrumb from the root to the current prefix.
 * Each segment is its own link; the final segment is highlighted but still
 * a link (clicking does nothing visible — same page).
 */
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

function FolderCard({ folder }: { folder: FolderEntry }) {
  return (
    <Link
      href={folderHref(folder.path)}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 transition-colors hover:bg-muted"
    >
      <FolderIcon className="h-8 w-8 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {folder.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {folder.assetCount} {folder.assetCount === 1 ? "item" : "items"}
        </p>
      </div>
    </Link>
  );
}

function FoldersContent() {
  const searchParams = useSearchParams();
  const prefix = searchParams.get("path") ?? "";

  // Carry the prefix the loaded data corresponds to alongside the data
  // itself; `loading` is derived from `loadedPrefix !== prefix`. This avoids
  // setting loading=true inside an effect (react-hooks/set-state-in-effect).
  const [state, setState] = useState<{
    loadedPrefix: string | null;
    listing: FolderListing | null;
    assets: Asset[];
  }>({ loadedPrefix: null, listing: null, assets: [] });
  const loading = state.loadedPrefix !== prefix;
  const listing = state.loadedPrefix === prefix ? state.listing : null;
  const assets = state.loadedPrefix === prefix ? state.assets : [];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const url = prefix
      ? `/api/v1/folders?prefix=${encodeURIComponent(prefix)}`
      : "/api/v1/folders";

    Promise.all([
      fetch(url).then((r) => r.json()) as Promise<FolderListing>,
      // Pull the asset list for this workspace and filter client-side to the
      // current prefix. Server-side filtering would need a new query param
      // on /api/v1/assets; given the typical folder size (hundreds of items)
      // this is cheap and keeps the API surface small.
      fetch("/api/v1/assets")
        .then((r) => r.json())
        .then(
          (d) =>
            (d.assets ?? []) as (Asset & {
              directoryPath?: string | null;
            })[]
        ),
    ])
      .then(([folderData, assetData]) => {
        if (cancelled) return;
        const wanted = prefix || null;
        const filtered = assetData.filter(
          (a) => (a.directoryPath ?? null) === wanted
        );
        setState({
          loadedPrefix: prefix,
          listing: folderData,
          assets: filtered,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          loadedPrefix: prefix,
          listing: { prefix, folders: [], assetsAtThisLevel: 0 },
          assets: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [prefix]);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Folders</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Browse your library by the directory tree it came from.
            </p>
          </div>
        </div>
      </div>

      <Breadcrumb prefix={listing?.prefix ?? prefix} />

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading folder…
        </div>
      ) : (
        <>
          {listing && listing.folders.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Folders
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {listing.folders.map((f) => (
                  <FolderCard key={f.path} folder={f} />
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
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {assets.map((asset, index) => (
                  <div key={asset.id} onClick={() => setLightboxIndex(index)}>
                    <PhotoCard asset={asset} showQuickActions={false} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {listing &&
            listing.folders.length === 0 &&
            assets.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <ImageIcon className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  This folder is empty. Uploads carry their source directory
                  via the <code className="text-foreground">X-Fonto-Path</code>{" "}
                  header (multipart), the <code className="text-foreground">path</code>{" "}
                  field on <code className="text-foreground">/assets/init</code>,
                  or <code className="text-foreground">metadata.path</code> on
                  tus.
                </p>
              </div>
            )}
        </>
      )}

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
  );
}

export default function FoldersPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-muted-foreground py-4">Loading…</div>
      }
    >
      <FoldersContent />
    </Suspense>
  );
}
