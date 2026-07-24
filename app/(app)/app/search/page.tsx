// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// /search — UX-3 sweep. Adopts AssetPageToolbar so the q input is the
// shared debounced input (no more letter-drop under fast typing); puts
// classification / date range / tag / color in the shared FilterPopover.
// Search-specific toggles (OCR-only, semantic, dual CLIP results panel)
// stay inline next to the toolbar because they have no analogue on
// other pages.
//
// Smart-collection mode (?smartCollection=<id>) renders a simpler shell:
// the toolbar becomes a read-only header and the results come from the
// smart-collections preview endpoint.

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  File,
  Image as ImageIcon,
  FileText,
  ScanText,
  Sparkles,
} from "lucide-react";
import { DocumentViewer } from "@/components/document-viewer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { ListErrorState } from "../_components/list-states";
import { ListSkeleton } from "../_components/grid-skeleton";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

// Phase 4.2 — heuristic for "fire a CLIP search alongside the text search".
// Queries with >3 words usually describe a scene rather than name a file,
// and queries containing one of these visual verbs almost always want a
// semantic match. False positives just produce an extra section.
const SEMANTIC_VERBS = [
  "show", "find", "with", "wearing", "holding", "near", "looking", "of",
  "containing", "featuring", "during", "at",
];

function looksSemantic(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 3) return true;
  const lower = trimmed.toLowerCase();
  return SEMANTIC_VERBS.some(
    (v) => lower.includes(` ${v} `) || lower.startsWith(`${v} `)
  );
}

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string | null;
  classification: string | null;
  description: string | null;
  extractedText: string | null;
  capturedAt: string | null;
  createdAt: string;
}

interface ClipHit { asset: Asset; similarity: number }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/"))
    return <ImageIcon className="h-5 w-5 text-[var(--ft-color-tertiary)]" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/"))
    return <FileText className="h-5 w-5 text-[var(--ft-color-secondary)]" />;
  return <File className="h-5 w-5 text-[var(--ft-color-on-surface-variant)]" />;
}

function ResultRow({
  asset,
  similarity,
  onOpen,
}: {
  asset: Asset;
  similarity?: number;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] px-4 py-3 text-left hover:bg-[var(--ft-color-surface-container-low)] transition-colors"
    >
      <AssetIcon mimeType={asset.mimeType} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--ft-color-on-surface)]">{asset.filename}</p>
        {asset.description && (
          <p className="truncate text-xs text-[var(--ft-color-on-surface-variant)]">{asset.description}</p>
        )}
        <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
          {asset.classification ?? asset.mimeType} · {formatBytes(asset.sizeBytes)}
        </p>
      </div>
      {similarity != null ? (
        <span className="text-xs text-[var(--ft-color-tertiary)] whitespace-nowrap font-mono">
          {(similarity * 100).toFixed(0)}%
        </span>
      ) : (
        <span className="text-xs text-[var(--ft-color-on-surface-variant)] whitespace-nowrap">
          {new Date(asset.capturedAt ?? asset.createdAt).toLocaleDateString()}
        </span>
      )}
    </button>
  );
}

function SearchContent() {
  const router = useRouter();
  const urlParams = useSearchParams();
  const smartCollectionId = urlParams.get("smartCollection") ?? "";

  const toolbar = useToolbarState({
    page: "search",
    availableFilters: [
      "type",
      "from",
      "to",
      "color",
      "tagIds",
      "cameraMake",
      "cameraModel",
      "lensModel",
      "iso",
      "fNumber",
      "focalLength",
    ],
  });

  const [results, setResults] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [ocrOnly, setOcrOnly] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [clipHits, setClipHits] = useState<ClipHit[] | null>(null);
  const [clipUnavailable, setClipUnavailable] = useState(false);
  const [viewerAsset, setViewerAsset] = useState<Asset | null>(null);

  function openAsset(a: Asset) {
    const isDoc = !a.mimeType.startsWith("image/");
    if (isDoc && (a.mimeType === "application/pdf" || a.extractedText)) {
      setViewerAsset(a);
    } else {
      // Deep-link into the library lightbox for THIS asset. The library reads
      // ?lb=<id> and fetches out-of-list assets directly, so the result the
      // user clicked actually opens — instead of dumping them into the
      // generic library with nothing selected.
      router.push(`/app/library?lb=${a.id}`);
    }
  }

  const doSearch = useCallback(async () => {
    // Smart-collection mode: ignore filters, fetch the preview.
    if (smartCollectionId) {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/v1/smart-collections/${smartCollectionId}/assets`);
        if (!res.ok) throw new Error(`smart-collection ${res.status}`);
        const data = (await res.json()) as { assets?: Asset[] };
        setResults(data.assets ?? []);
      } catch {
        setError(true);
        setResults(null);
      } finally {
        setLoading(false);
      }
      return;
    }

    const q = toolbar.filters.q.trim();
    const cl = toolbar.filters.type ?? "";
    const df = toolbar.filters.from ?? "";
    const dt = toolbar.filters.to ?? "";
    const col = toolbar.filters.color ?? "";
    const tid = toolbar.filters.tagIds[0] ?? "";
    const exif = {
      cameraMake: toolbar.filters.cameraMake ?? "",
      cameraModel: toolbar.filters.cameraModel ?? "",
      lensModel: toolbar.filters.lensModel ?? "",
      iso: toolbar.filters.iso ?? "",
      fNumber: toolbar.filters.fNumber ?? "",
      focalLength: toolbar.filters.focalLength ?? "",
    };
    const hasExif = Object.values(exif).some((v) => v !== "");

    if (!q && !cl && !tid && !df && !dt && !ocrOnly && !col && !hasExif) {
      setResults(null);
      setClipHits(null);
      setClipUnavailable(false);
      return;
    }

    setLoading(true);
    setError(false);
    try {
      // Phase 4.2 — kick off the CLIP search in parallel for "natural"
      // queries. Skipping when other structured filters are active keeps
      // the semantic block out of pure-filter views like "tag=foo".
      if (q && looksSemantic(q) && !tid && !cl && !col && !hasExif) {
        const clipParams = new URLSearchParams({ q, limit: "24" });
        fetch(`/api/v1/search/clip?${clipParams.toString()}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d) {
              setClipHits([]);
              setClipUnavailable(false);
              return;
            }
            setClipUnavailable(!!d.unavailable);
            setClipHits(Array.isArray(d.results) ? d.results : []);
          })
          .catch(() => {
            setClipHits([]);
            setClipUnavailable(false);
          });
      } else {
        setClipHits(null);
        setClipUnavailable(false);
      }

      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cl) params.set("classification", cl);
      if (tid) params.set("tagId", tid);
      if (df) params.set("dateFrom", df);
      if (dt) params.set("dateTo", dt);
      if (semantic) params.set("semantic", "true");
      if (ocrOnly) params.set("ocrOnly", "true");
      if (col) params.set("color", col);
      for (const [k, v] of Object.entries(exif)) {
        if (v) params.set(k, v);
      }

      const res = await fetch(`/api/v1/search?${params.toString()}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      const data = (await res.json()) as { assets?: Asset[] };
      setResults(data.assets ?? []);
    } catch {
      setError(true);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [
    smartCollectionId,
    toolbar.filters.q,
    toolbar.filters.type,
    toolbar.filters.from,
    toolbar.filters.to,
    toolbar.filters.color,
    toolbar.filters.tagIds,
    toolbar.filters.cameraMake,
    toolbar.filters.cameraModel,
    toolbar.filters.lensModel,
    toolbar.filters.iso,
    toolbar.filters.fNumber,
    toolbar.filters.focalLength,
    ocrOnly,
    semantic,
  ]);

  useEffect(() => {
    void doSearch();
  }, [doSearch]);

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title={smartCollectionId ? "Smart Collection" : "Search"}
        count={loading ? undefined : results?.length}
        toolbar={toolbar}
        searchPlaceholder="Search filenames, descriptions, OCR text…"
        sortOptions={[]}
        filterKeys={smartCollectionId ? [] : ["type", "from", "to", "color", "tagIds"]}
        showDensity={false}
        showSelect={false}
      />

      <div className="px-4 space-y-4">
        {!smartCollectionId && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Search-specific toggles. These three have no analogue on
                other pages so they live next to the toolbar instead of
                inside FilterPopover. */}
            <Button
              variant={ocrOnly ? "filled" : "outlined"}
              size="sm"
              onClick={() => setOcrOnly((v) => !v)}
              title="Search OCR text only — matches words extracted from image content"
            >
              <ScanText className="h-3.5 w-3.5" />
              OCR only
            </Button>
            <Button
              variant={semantic ? "filled" : "outlined"}
              size="sm"
              onClick={() => setSemantic((v) => !v)}
              title="Semantic search via Plexo AI"
              className={cn(semantic && "bg-[var(--ft-color-tertiary)] text-[var(--ft-color-on-tertiary)] hover:brightness-95")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Semantic
            </Button>
          </div>
        )}

        {smartCollectionId && (
          <p className="text-sm text-muted-foreground">
            Smart collection results — filters disabled
          </p>
        )}

        {/* Empty / loading / no-results / error states. Loading is the
            outer guard — between setResults([]) and setLoading(false) the
            old order let the truthy-results branch fire briefly with a
            "0 results" pill, which read as a flash of stale state. */}
        {loading ? (
          <ListSkeleton count={6} />
        ) : error ? (
          <ListErrorState
            message="Couldn't run that search. Check your connection and retry."
            onRetry={() => void doSearch()}
          />
        ) : results === null && !smartCollectionId ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Type to search your assets, or set a filter.
          </p>
        ) : results?.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No assets found.
          </p>
        ) : results ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {results.length} result{results.length !== 1 ? "s" : ""}
            </p>
            {results.map((asset) => (
              <ResultRow key={asset.id} asset={asset} onOpen={() => openAsset(asset)} />
            ))}
          </div>
        ) : null}

        {/* Phase 4.2 — CLIP semantic results, rendered under text matches
            any time a CLIP search has been run for the current query (even
            with 0 hits) so the user knows semantic matching contributed. */}
        {clipHits !== null && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 border-t border-[var(--ft-color-outline-variant)] pt-4">
              <Sparkles className="h-3.5 w-3.5 text-[var(--ft-color-tertiary)]" />
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Visually similar
              </p>
              {clipUnavailable && (
                <span className="text-xs text-muted-foreground">
                  (semantic search service unavailable)
                </span>
              )}
            </div>
            {clipHits.length === 0
              ? !clipUnavailable && (
                  <p className="text-sm text-muted-foreground">No semantic matches.</p>
                )
              : (
                <div className="space-y-1.5">
                  {clipHits.map((hit) => (
                    <ResultRow
                      key={`clip-${hit.asset.id}`}
                      asset={hit.asset}
                      similarity={hit.similarity}
                      onOpen={() => openAsset(hit.asset)}
                    />
                  ))}
                </div>
              )}
          </div>
        )}
      </div>

      {viewerAsset && (
        <DocumentViewer
          assetId={viewerAsset.id}
          filename={viewerAsset.filename}
          mimeType={viewerAsset.mimeType}
          extractedText={viewerAsset.extractedText}
          onClose={() => setViewerAsset(null)}
        />
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--ft-color-on-surface-variant)] py-4">Loading…</div>}>
      <SearchContent />
    </Suspense>
  );
}
