// SPDX-License-Identifier: MIT
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

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  File,
  Image as ImageIcon,
  FileText,
  ScanText,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";
import { DocumentViewer } from "@/components/document-viewer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { ListErrorState } from "../_components/list-states";
import { ListSkeleton } from "../_components/grid-skeleton";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import type { Asset as GridAsset } from "../_components/photo-card";

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

interface SimilarState {
  status: "idle" | "loading" | "success" | "error";
  assets: Asset[];
  source: "clip" | "classification" | null;
}

const SIMILAR_IDLE: SimilarState = { status: "idle", assets: [], source: null };

// Stable id for the single "visually similar" panel rendered beneath the
// grid — every tile's toggle button points aria-controls at the same panel,
// since only one is ever shown at a time (see SearchContent).
const SIMILAR_PANEL_ID = "similar-results-panel";

// O2 — per-tile "Visually similar" toggle. Rendered via AssetGrid's
// renderTileAction slot, one per tile. Pure presentation: the fetch, cache,
// and expanded/collapsed source of truth live in SearchContent so exactly
// one results panel exists (see the "one panel at a time" note there).
function SimilarToggleButton({
  asset,
  active,
  onToggle,
}: {
  asset: Asset;
  active: boolean;
  onToggle: (assetId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={active}
      aria-controls={active ? SIMILAR_PANEL_ID : undefined}
      aria-label={`${active ? "Hide" : "Show"} assets visually similar to ${asset.filename}`}
      onClick={() => onToggle(asset.id)}
      className="flex w-full items-center justify-center gap-0.5 rounded-[var(--ft-shape-small)] py-0.5 text-[10px] text-[var(--ft-color-on-surface-variant)] hover:bg-[var(--ft-color-surface-container-low)] hover:text-[var(--ft-color-on-surface)] transition-colors"
    >
      {active ? (
        <ChevronDown className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
      Similar
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
  // Plain/FTS pagination (color-ΔE and semantic re-rank never page — the API
  // always sends cursor: null for those and flags `truncated` instead).
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const cursorRef = useRef<string | null>(null);
  // Bumped on every first-page (re)search so an in-flight loadMore or a
  // slow first-page request from a previous query can't commit a stale
  // cursor or stale results onto the current one.
  const searchGenRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // O2 — single "visually similar" panel shared by every tile's toggle.
  // similarCacheRef holds one resolved result per asset id so switching away
  // from a tile and back (or a parent re-render from loadMore) never
  // refetches; similarGenRef guards against a slow in-flight fetch for a
  // previous tile clobbering the currently-selected one.
  const [similarAssetId, setSimilarAssetId] = useState<string | null>(null);
  const [similarState, setSimilarState] = useState<SimilarState>(SIMILAR_IDLE);
  const similarCacheRef = useRef<Map<string, SimilarState>>(new Map());
  const similarGenRef = useRef(0);

  const fetchSimilar = useCallback((assetId: string) => {
    const gen = ++similarGenRef.current;
    setSimilarState({ status: "loading", assets: [], source: null });
    void (async () => {
      try {
        const res = await fetch(`/api/v1/assets/${assetId}/similar`);
        if (!res.ok) throw new Error(`similar ${res.status}`);
        const data = (await res.json()) as {
          assets?: Asset[];
          source?: "clip" | "classification";
        };
        if (gen !== similarGenRef.current) return;
        const next: SimilarState = {
          status: "success",
          assets: data.assets ?? [],
          source: data.source ?? null,
        };
        similarCacheRef.current.set(assetId, next);
        setSimilarState(next);
      } catch {
        if (gen !== similarGenRef.current) return;
        setSimilarState({ status: "error", assets: [], source: null });
      }
    })();
  }, []);

  useEffect(() => {
    if (!similarAssetId) return;
    const cached = similarCacheRef.current.get(similarAssetId);
    if (cached) {
      similarGenRef.current++;
      setSimilarState(cached);
      return;
    }
    fetchSimilar(similarAssetId);
  }, [similarAssetId, fetchSimilar]);

  function toggleSimilar(assetId: string) {
    setSimilarAssetId((cur) => (cur === assetId ? null : assetId));
  }

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

  // Shared param-builder so the first page (doSearch) and every subsequent
  // page (loadMore) encode the exact same filter set — the only thing that
  // may differ between the two requests is `cursor`.
  const buildSearchParams = useCallback(() => {
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

    return { q, cl, df, dt, col, tid, hasExif, params };
  }, [
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
    semantic,
    ocrOnly,
  ]);

  const doSearch = useCallback(async () => {
    // Bump first — this is what makes a query/filter change reset paging: any
    // loadMore or first-page fetch still in flight from the PREVIOUS query
    // checks this generation before it writes cursor/results, so a stale
    // cursor from a previous query can never be echoed back to the API.
    const gen = ++searchGenRef.current;
    cursorRef.current = null;
    setHasMore(false);
    setLoadingMore(false);
    setPageError(false);
    setTruncated(false);
    // A new search invalidates any open "visually similar" panel and its
    // cache — the source asset may not even be in the new result set.
    setSimilarAssetId(null);
    similarCacheRef.current.clear();

    // Smart-collection mode: ignore filters, fetch the preview. Not paged.
    if (smartCollectionId) {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/v1/smart-collections/${smartCollectionId}/assets`);
        if (!res.ok) throw new Error(`smart-collection ${res.status}`);
        const data = (await res.json()) as { assets?: Asset[] };
        if (gen !== searchGenRef.current) return;
        setResults(data.assets ?? []);
      } catch {
        if (gen !== searchGenRef.current) return;
        setError(true);
        setResults(null);
      } finally {
        if (gen === searchGenRef.current) setLoading(false);
      }
      return;
    }

    const { q, cl, df, dt, col, tid, hasExif, params } = buildSearchParams();

    if (!q && !cl && !tid && !df && !dt && !ocrOnly && !col && !hasExif) {
      setResults(null);
      setClipHits(null);
      setClipUnavailable(false);
      return;
    }

    setLoading(true);
    setError(false);
    try {
      // M1 (W3) — CLIP is behind the explicit Semantic toggle; the old
      // heuristic `looksSemantic(q)` auto-fired a second list at ~900ms that
      // fought the text results. Keep the helper for a future "suggest
      // turning semantic on" hint, but don't fetch until the user opts in.
      if (q && semantic && !tid && !cl && !col && !hasExif) {
        const clipParams = new URLSearchParams({ q, limit: "24" });
        fetch(`/api/v1/search/clip?${clipParams.toString()}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (gen !== searchGenRef.current) return;
            if (!d) {
              setClipHits([]);
              setClipUnavailable(false);
              return;
            }
            setClipUnavailable(!!d.unavailable);
            setClipHits(Array.isArray(d.results) ? d.results : []);
          })
          .catch(() => {
            if (gen !== searchGenRef.current) return;
            setClipHits([]);
            setClipUnavailable(false);
          });
      } else {
        setClipHits(null);
        setClipUnavailable(false);
      }

      const res = await fetch(`/api/v1/search?${params.toString()}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      const data = (await res.json()) as {
        assets?: Asset[];
        cursor?: string | null;
        truncated?: boolean;
      };
      if (gen !== searchGenRef.current) return;
      setResults(data.assets ?? []);
      cursorRef.current = data.cursor ?? null;
      setHasMore(!!data.cursor);
      setTruncated(!!data.truncated);
    } catch {
      if (gen !== searchGenRef.current) return;
      setError(true);
      setResults(null);
      setHasMore(false);
      setTruncated(false);
    } finally {
      if (gen === searchGenRef.current) setLoading(false);
    }
  }, [smartCollectionId, buildSearchParams, ocrOnly, semantic]);

  // Next-page fetch for plain/FTS search, echoing the cursor the previous
  // page returned. A stale generation (query changed since this was queued)
  // drops its response instead of appending onto the new query's results.
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const cursor = cursorRef.current;
    if (!cursor) return;
    const gen = searchGenRef.current;
    setLoadingMore(true);
    setPageError(false);
    try {
      const { params } = buildSearchParams();
      params.set("cursor", cursor);
      const res = await fetch(`/api/v1/search?${params.toString()}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      const data = (await res.json()) as { assets?: Asset[]; cursor?: string | null };
      if (gen !== searchGenRef.current) return;
      setResults((prev) => [...(prev ?? []), ...((data.assets ?? []) as Asset[])]);
      cursorRef.current = data.cursor ?? null;
      setHasMore(!!data.cursor);
    } catch {
      // Leave cursorRef + hasMore untouched — the cursor may still be good
      // (transient network failure), so Retry replays the same page instead
      // of silently ending the list.
      if (gen === searchGenRef.current) setPageError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, buildSearchParams]);

  // Auto-load the next page when the sentinel below the results nears the
  // viewport. `hasMore` is only ever true in plain/FTS mode (the API sends a
  // null cursor for color/semantic), so this never fires in a mode that
  // cannot page. `pageError` is excluded on purpose: while a page load is
  // failing, the sentinel stays mounted (Retry needs it) but must NOT be
  // observed, or loadMore's identity change on every failed attempt
  // (loadingMore flips false) would tear down + re-observe the
  // still-on-screen sentinel and refire immediately — an unbounded retry
  // loop. Re-arming happens only via the explicit Retry button.
  useEffect(() => {
    if (!hasMore || pageError) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, pageError, loadMore]);

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
          <div className="space-y-1">
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
                title="Semantic search via vision embeddings"
                className={cn(semantic && "bg-[var(--ft-color-tertiary)] text-[var(--ft-color-on-tertiary)] hover:brightness-95")}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Semantic
              </Button>
            </div>
            <p className="text-[11px] leading-3 text-[var(--ft-color-on-surface-variant)]">
              {ocrOnly ? "Searching text extracted from images (OCR)." : null}
              {ocrOnly && semantic ? " · " : null}
              {semantic ? "Visually similar results (CLIP) on." : ocrOnly ? null : "Tip: toggle Semantic for visual search or OCR only for text in images."}
            </p>
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
          <div className="space-y-2">
            {/* Count reflects the accumulated results array, never a response
                field — it's the honest "how many are loaded", not a claimed
                total match count. Suppressed when truncated so the truncation
                notice below is the single source of truth for the number
                instead of two figures that could disagree. */}
            {!truncated && (
              <p className="text-xs text-muted-foreground">
                {results.length} result{results.length !== 1 ? "s" : ""}
                {hasMore ? " loaded so far" : ""} — grid mirrors Library (Immich: search is filtered timeline)
              </p>
            )}
            {/* Honest truncation — color-ΔE and semantic re-rank never return a
                cursor, so a cut-off result set says so instead of pretending
                the list is complete. */}
            {truncated && (
              <p className="text-[11px] leading-3 text-[var(--ft-color-on-surface-variant)]">
                Showing the first {results.length} matches — narrow your search to see more.
              </p>
            )}
            <AssetGrid
              assets={results as unknown as GridAsset[]}
              toolbar={toolbar}
              onAssetClick={(id) => {
                const a = results.find((r) => r.id === id);
                if (a) openAsset(a);
              }}
              renderTileAction={
                smartCollectionId
                  ? undefined
                  : (a) => (
                      <SimilarToggleButton
                        asset={a as unknown as Asset}
                        active={similarAssetId === a.id}
                        onToggle={toggleSimilar}
                      />
                    )
              }
            />
            {/* O2 — one "visually similar" panel at a time, anchored below the
                grid rather than duplicated per-row: opening a second tile's
                results replaces this panel instead of stacking another list. */}
            {similarAssetId && (
              <div
                id={SIMILAR_PANEL_ID}
                className="space-y-1.5 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[var(--ft-color-on-surface)]">
                    Visually similar to{" "}
                    {results.find((r) => r.id === similarAssetId)?.filename ?? "selected asset"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSimilarAssetId(null)}
                    aria-label="Close visually similar panel"
                    className="rounded-[var(--ft-shape-small)] p-1 text-[var(--ft-color-on-surface-variant)] hover:bg-[var(--ft-color-surface-container-low)] hover:text-[var(--ft-color-on-surface)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {similarState.status === "loading" && (
                  <p className="flex items-center gap-1.5 text-xs text-[var(--ft-color-on-surface-variant)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Looking for similar assets…
                  </p>
                )}
                {similarState.status === "error" && (
                  <p className="text-xs text-[var(--ft-color-error)]">
                    Couldn&apos;t load similar assets.{" "}
                    <button
                      type="button"
                      onClick={() => fetchSimilar(similarAssetId)}
                      className="underline underline-offset-2"
                    >
                      Retry
                    </button>
                  </p>
                )}
                {similarState.status === "success" && similarState.assets.length === 0 && (
                  <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
                    No visually similar matches.
                  </p>
                )}
                {similarState.status === "success" && similarState.assets.length > 0 && (
                  <div className="space-y-1.5">
                    {similarState.source === "classification" && (
                      <p className="text-[11px] leading-3 text-[var(--ft-color-on-surface-variant)]">
                        No visual embedding yet — showing same-category matches.
                      </p>
                    )}
                    {similarState.assets.map((a) => (
                      <ResultRow key={a.id} asset={a} onOpen={() => openAsset(a)} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Infinite scroll for plain/FTS mode, mirroring the library flat
                grid's sentinel idiom — never a "Load more" button. hasMore is
                only true when the API sent a cursor, which excludes the
                color/semantic modes by construction. */}
            {hasMore && (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center gap-[var(--ft-space-2)] py-6 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]"
              >
                {pageError ? (
                  <p className="text-xs text-[var(--ft-color-error)]">
                    Couldn&apos;t load more results.{" "}
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      className="underline underline-offset-2"
                    >
                      Retry
                    </button>
                  </p>
                ) : (
                  <>
                    {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                    {loadingMore ? "Loading more…" : ""}
                  </>
                )}
              </div>
            )}
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
