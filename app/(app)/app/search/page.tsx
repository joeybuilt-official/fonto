// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, File, Image as ImageIcon, FileText, Loader2, SlidersHorizontal, X, Sparkles, ScanText, Palette } from "lucide-react";
import { DocumentViewer } from "@/components/document-viewer";

// 12 representative quick-pick colors for the palette filter. Chosen to span
// the hue wheel + neutrals so the user can land on the right family in one tap.
const QUICK_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#000000", // black (catches dark photos)
];

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

interface Tag { id: string; name: string; color: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssetIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-5 w-5 text-blue-400" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/"))
    return <FileText className="h-5 w-5 text-orange-400" />;
  return <File className="h-5 w-5 text-muted-foreground" />;
}

const CLASSIFICATION_OPTIONS = [
  "photo", "screenshot", "mockup", "logo", "icon",
  "receipt", "contract", "letter", "report", "form", "document", "scan",
];

function SearchInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const smartCollectionId = searchParams.get("smartCollection") ?? "";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Asset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [ocrOnly, setOcrOnly] = useState(false);

  // Filter state
  const [classification, setClassification] = useState("");
  const [tagId, setTagId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [color, setColor] = useState("");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Document viewer
  const [viewerAsset, setViewerAsset] = useState<Asset | null>(null);

  useEffect(() => {
    fetch("/api/v1/tags")
      .then((r) => r.json())
      .then((d) => setTags(d.tags ?? []))
      .catch(() => {});
  }, []);

  // Close color picker on outside click.
  useEffect(() => {
    if (!showColorPicker) return;
    function onClick(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showColorPicker]);

  const doSearch = useCallback(async (opts?: {
    q?: string; cl?: string; tid?: string; df?: string; dt?: string; sem?: boolean; scId?: string;
    ocr?: boolean; col?: string;
  }) => {
    const q = opts?.q ?? query;
    const cl = opts?.cl ?? classification;
    const tid = opts?.tid ?? tagId;
    const df = opts?.df ?? dateFrom;
    const dt = opts?.dt ?? dateTo;
    const sem = opts?.sem ?? semantic;
    const ocr = opts?.ocr ?? ocrOnly;
    const col = opts?.col ?? color;
    const scId = opts?.scId ?? smartCollectionId;

    setLoading(true);
    try {
      if (scId) {
        const res = await fetch(`/api/v1/smart-collections/${scId}/assets`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.assets ?? []);
        }
        return;
      }

      if (!q.trim() && !cl && !tid && !df && !dt && !ocr && !col) {
        setResults(null);
        return;
      }

      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (cl) params.set("classification", cl);
      if (tid) params.set("tagId", tid);
      if (df) params.set("dateFrom", df);
      if (dt) params.set("dateTo", dt);
      if (sem) params.set("semantic", "true");
      if (ocr) params.set("ocrOnly", "true");
      if (col) params.set("color", col);

      const res = await fetch(`/api/v1/search?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.assets ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [query, classification, tagId, dateFrom, dateTo, semantic, ocrOnly, color, smartCollectionId]);

  // Execute smart collection query on mount if smartCollectionId present
  useEffect(() => {
    if (smartCollectionId) doSearch({ scId: smartCollectionId });
  }, [smartCollectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFilters = classification || tagId || dateFrom || dateTo || color || ocrOnly;

  function clearFilters() {
    setClassification("");
    setTagId("");
    setDateFrom("");
    setDateTo("");
    setColor("");
    setOcrOnly(false);
    doSearch({ cl: "", tid: "", df: "", dt: "", col: "", ocr: false });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Search</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {smartCollectionId ? "Smart collection results" : "Search by filename, description, extracted text, or classification"}
        </p>
      </div>

      {!smartCollectionId && (
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); doSearch({ q: e.target.value }); }}
              placeholder="Search assets…"
              autoFocus
              className="w-full rounded-lg border border-border bg-background pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            onClick={() => setShowFilters((f) => !f)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${hasFilters || showFilters ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {hasFilters && <span className="rounded-full bg-foreground text-background text-xs w-4 h-4 flex items-center justify-center">!</span>}
          </button>
          <button
            onClick={() => { setOcrOnly((o) => !o); doSearch({ ocr: !ocrOnly }); }}
            title="Search OCR text only — matches words extracted from image content"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${ocrOnly ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
          >
            <ScanText className="h-3.5 w-3.5" />
          </button>
          <div ref={colorPickerRef} className="relative">
            <button
              onClick={() => setShowColorPicker((v) => !v)}
              title="Filter by dominant color"
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${color ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
            >
              {color ? (
                <span className="h-3.5 w-3.5 rounded-sm border border-border" style={{ backgroundColor: color }} />
              ) : (
                <Palette className="h-3.5 w-3.5" />
              )}
            </button>
            {showColorPicker && (
              <div className="absolute right-0 top-full mt-2 z-30 w-56 rounded-lg border border-border bg-popover p-3 shadow-lg">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Color</p>
                <div className="grid grid-cols-6 gap-1.5">
                  {QUICK_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => { setColor(c); setShowColorPicker(false); doSearch({ col: c }); }}
                      className={`h-7 w-7 rounded-md border-2 transition-all ${color === c ? "border-foreground scale-110" : "border-transparent hover:border-border"}`}
                      style={{ backgroundColor: c }}
                      title={c}
                      aria-label={`Filter by ${c}`}
                    />
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && /^#?[0-9a-f]{3,6}$/i.test(color)) {
                        const norm = color.startsWith("#") ? color : `#${color}`;
                        setColor(norm); setShowColorPicker(false); doSearch({ col: norm });
                      }
                    }}
                    placeholder="#rrggbb"
                    className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {color && (
                    <button
                      onClick={() => { setColor(""); setShowColorPicker(false); doSearch({ col: "" }); }}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                      title="Clear color filter"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => { setSemantic((s) => !s); doSearch({ sem: !semantic }); }}
            title="Semantic search via Plexo AI"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${semantic ? "border-amber-400 text-amber-400" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
        </div>
      )}

      {showFilters && !smartCollectionId && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Filters</p>
            {hasFilters && (
              <button onClick={clearFilters} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Classification</label>
              <select
                value={classification}
                onChange={(e) => { setClassification(e.target.value); doSearch({ cl: e.target.value }); }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Any</option>
                {CLASSIFICATION_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            {tags.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tag</label>
                <select
                  value={tagId}
                  onChange={(e) => { setTagId(e.target.value); doSearch({ tid: e.target.value }); }}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Any tag</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); doSearch({ df: e.target.value }); }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); doSearch({ dt: e.target.value }); }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </div>
      )}

      {results === null && !smartCollectionId ? (
        <p className="text-sm text-muted-foreground text-center py-8">Type to search your assets</p>
      ) : results?.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No assets found.</p>
      ) : results ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{results.length} result{results.length !== 1 ? "s" : ""}</p>
          {results.map((asset) => (
            <button
              key={asset.id}
              onClick={() => {
                const isDoc = !asset.mimeType.startsWith("image/");
                if (isDoc && (asset.mimeType === "application/pdf" || asset.extractedText)) {
                  setViewerAsset(asset);
                } else if (asset.mimeType.startsWith("image/")) {
                  router.push("/app/photos");
                } else {
                  router.push("/app/documents");
                }
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-muted/40 transition-colors"
            >
              <AssetIcon mimeType={asset.mimeType} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{asset.filename}</p>
                {asset.description && (
                  <p className="truncate text-xs text-muted-foreground">{asset.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {asset.classification ?? asset.mimeType} · {formatBytes(asset.sizeBytes)}
                </p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(asset.capturedAt ?? asset.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      ) : null}

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
    <Suspense>
      <SearchInner />
    </Suspense>
  );
}
