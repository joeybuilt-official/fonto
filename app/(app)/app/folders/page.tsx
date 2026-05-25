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

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Folder as FolderIcon,
  Home,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { PhotoLightbox } from "../_components/photo-lightbox";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

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

  const toolbar = useToolbarState({
    page: "folders",
    availableFilters: ["mime", "type", "favorite", "ratingMin"],
  });

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
      fetch(folderUrl).then((r) => r.json()) as Promise<FolderListing>,
      fetch(assetUrl.toString())
        .then((r) => r.json())
        .then((d) => (d.assets ?? []) as Asset[]),
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
  ]);

  function navLightbox(delta: number) {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + delta;
    if (next >= 0 && next < assets.length) setLightboxIndex(next);
  }

  const visibleTitle = prefix
    ? prefix.split("/").filter(Boolean).pop() ?? "Folders"
    : "Folders";

  return (
    <div className="space-y-3">
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
  );
}

export default function FoldersPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <FoldersContent />
    </Suspense>
  );
}
