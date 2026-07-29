// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — Files surface.
//
// A retrieval-oriented surface (vs the Photos timeline): pinned search bar
// (server-side filename + OCR + source), recency bands, LIST rows (type icon +
// filename + OCR/source snippet + imported date), imported-at DESC, and a
// Properties sheet on tap. See plans/photos-vs-files-split/plan.md.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  X,
  Loader2,
  Smartphone,
  Palette,
  FileText,
  FileQuestion,
  FolderTree,
  Download,
} from "lucide-react";
import { type Asset } from "./photo-card";
import { trackLibrary } from "@/lib/telemetry/library";

function kindIcon(kind: string | null | undefined): React.ComponentType<{ className?: string }> {
  switch (kind) {
    case "screenshot":
      return Smartphone;
    case "graphics":
      return Palette;
    case "document":
      return FileText;
    default:
      return FileQuestion;
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Recency band for the imported-at axis. Two buckets per the spec: "This week"
// and "Earlier".
function band(iso: string, nowMs: number): "This week" | "Earlier" {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return nowMs - new Date(iso).getTime() <= weekMs ? "This week" : "Earlier";
}

function snippet(a: Asset): string | null {
  const text = (a.ocrText ?? a.description ?? "").trim();
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed;
}

export function LibraryFilesView({
  kindParam,
  directoryPathPrefix,
  onOpenFolder,
}: {
  kindParam: string | null;
  directoryPathPrefix?: string | null;
  onOpenFolder?: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [propsAsset, setPropsAsset] = useState<Asset | null>(null);
  const nowRef = useRef<number>(0);

  // Debounce the search box (server-side q).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const sp = new URLSearchParams();
    sp.set("lifecycle", "active");
    sp.set("sort", "created");
    sp.set("limit", "200");
    if (kindParam) sp.set("kind", kindParam);
    if (debounced) sp.set("q", debounced);
    if (directoryPathPrefix) sp.set("directoryPathPrefix", directoryPathPrefix);
    try {
      const r = await fetch(`/api/v1/assets?${sp.toString()}`);
      if (!r.ok) throw new Error(`assets ${r.status}`);
      const d = (await r.json()) as { assets?: Asset[] };
      const list = d.assets ?? [];
      setAssets(list);
      if (debounced) {
        trackLibrary("library_search", {
          surface: "files",
          query_len: debounced.length,
          result_count: list.length,
        });
      }
    } catch {
      setAssets([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [kindParam, debounced, directoryPathPrefix]);

  useEffect(() => {
    nowRef.current = Date.now();
    void load();
  }, [load]);

  // Group into recency bands, preserving the imported-at DESC order.
  const groups: { band: string; items: Asset[] }[] = [];
  for (const a of assets) {
    const b = band(a.createdAt, nowRef.current || Date.now());
    const last = groups[groups.length - 1];
    if (last && last.band === b) last.items.push(a);
    else groups.push({ band: b, items: [a] });
  }

  return (
    <div className="px-4">
      {/* Pinned search bar */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-[var(--ft-color-surface)]/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-[var(--ft-space-3)]">
          <Search className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files — name, text, source…"
            className="h-9 flex-1 bg-transparent text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] placeholder:text-[var(--ft-color-on-surface-variant)] focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search">
              <X className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[length:var(--ft-type-body-medium-size)] text-[var(--ft-color-on-surface-variant)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : loadError ? (
        <div className="py-12 text-center text-[length:var(--ft-type-body-medium-size)] text-[var(--ft-color-on-surface-variant)]">
          Couldn&apos;t load files.{" "}
          <button onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      ) : assets.length === 0 ? (
        <div className="py-16 text-center text-[length:var(--ft-type-body-medium-size)] text-[var(--ft-color-on-surface-variant)]">
          {debounced ? `No files match “${debounced}”.` : "No files yet."}
        </div>
      ) : (
        <div className="space-y-4 pb-8">
          {groups.map((g) => (
            <div key={g.band}>
              <p className="mb-1 px-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
                {g.band}
              </p>
              <div className="overflow-hidden rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)]">
                {g.items.map((a, i) => {
                  const Icon = kindIcon(a.kind);
                  const sub = snippet(a);
                  return (
                    <button
                      key={a.id}
                      onClick={() => {
                        setPropsAsset(a);
                        trackLibrary("library_properties_open", { kind: a.kind ?? null });
                      }}
                      className={`flex w-full items-center gap-[var(--ft-space-3)] px-[var(--ft-space-3)] py-[var(--ft-space-3)] text-left transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_5%,transparent)] ${
                        i > 0 ? "border-t border-[var(--ft-color-outline-variant)]" : ""
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container-high)] text-[var(--ft-color-on-surface-variant)]">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                          {a.filename}
                        </span>
                        <span className="block truncate text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                          {sub ?? `${a.kind ?? "file"} · ${fmtSize(a.sizeBytes)}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
                        {fmtDate(a.createdAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {propsAsset && (
        <FilePropertiesSheet
          asset={propsAsset}
          onClose={() => setPropsAsset(null)}
          onOpenFolder={onOpenFolder}
        />
      )}
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-[var(--ft-space-3)] py-1.5">
      <span className="text-[length:var(--ft-type-label-medium-size)] text-[var(--ft-color-on-surface-variant)]">
        {label}
      </span>
      <span className="text-right text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface)] break-all">
        {value}
      </span>
    </div>
  );
}

// Minimal v1 properties sheet: preview (when imageable), filename, kind,
// captured/imported dates, source-app, OCR excerpt, Open folder + download.
function FilePropertiesSheet({
  asset,
  onClose,
  onOpenFolder,
}: {
  asset: Asset;
  onClose: () => void;
  onOpenFolder?: (path: string) => void;
}) {
  const [full, setFull] = useState<Asset | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/assets/${asset.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { asset?: Asset } | null) => {
        if (alive && d?.asset) setFull(d.asset);
      })
      .catch(() => undefined);
    fetch(`/api/v1/assets/${asset.id}/url`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => {
        if (alive && d?.url) setUrl(d.url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [asset.id]);

  const a = full ?? asset;
  const isImageable = a.mimeType.startsWith("image/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirPath: string | null = (a as any).directoryPath ?? null;
  const ocr = (a.ocrText ?? "").trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--ft-color-scrim)]/50 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container-high)] p-[var(--ft-space-4)] shadow-[var(--ft-elev-3)] sm:max-w-md sm:rounded-[var(--ft-shape-large)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="truncate pr-2 text-[length:var(--ft-type-title-medium-size)] font-medium text-[var(--ft-color-on-surface)]">
            {a.filename}
          </p>
          <button onClick={onClose} aria-label="Close">
            <X className="h-5 w-5 text-[var(--ft-color-on-surface-variant)]" />
          </button>
        </div>

        {isImageable && url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={a.filename}
            className="mb-3 max-h-60 w-full rounded-[var(--ft-shape-medium)] object-contain"
          />
        )}

        <div className="divide-y divide-[var(--ft-color-outline-variant)]">
          <PropRow label="Type" value={a.kind ?? "—"} />
          <PropRow label="Format" value={a.mimeType} />
          <PropRow label="Size" value={fmtSize(a.sizeBytes)} />
          <PropRow label="Imported" value={fmtDate(a.createdAt)} />
          {a.capturedAt && <PropRow label="Captured" value={fmtDate(a.capturedAt)} />}
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {(a as any).source && <PropRow label="Source" value={String((a as any).source)} />}
        </div>

        {ocr && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[length:var(--ft-type-label-medium-size)] font-medium text-[var(--ft-color-on-surface-variant)]">
              Extracted text
            </summary>
            <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface)] p-2 text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface)]">
              {ocr}
            </p>
          </details>
        )}

        <div className="mt-4 flex gap-[var(--ft-space-2)]">
          {dirPath && onOpenFolder && (
            <button
              onClick={() => {
                onOpenFolder(dirPath);
                onClose();
              }}
              className="inline-flex h-9 flex-1 items-center justify-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] font-medium text-[var(--ft-color-on-secondary-container)]"
            >
              <FolderTree className="h-4 w-4" /> Open folder
            </button>
          )}
          {url && (
            <a
              href={url}
              download={a.filename}
              className="inline-flex h-9 flex-1 items-center justify-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] font-medium text-[var(--ft-color-on-surface)]"
            >
              <Download className="h-4 w-4" /> Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
