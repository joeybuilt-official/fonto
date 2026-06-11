// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-1 — /documents 3-column rebuild.
//
//   ┌─────────────┬──────────────────────┬───────────────────────┐
//   │ Type rail   │ Doc list (toolbar +  │ Persistent preview    │
//   │ (Receipts,  │  searchable rows w/  │ (PDF iframe / text    │
//   │  Contracts, │  thumbs)             │  / fallback "Open")   │
//   │  …)         │                      │                       │
//   └─────────────┴──────────────────────┴───────────────────────┘
//
// The audit (docs/ux-asset-page-audit-2026-05.md §4) flagged the prior
// 1-column list + modal-overlay preview as the worst wasted-space page
// in the app (score 5/5). The 3-pane shell here lets the user scan +
// preview without losing context, and the preview is deep-linkable via
// ?selected=<id>.
//
// Bug §UX-4 carried forward: when a subtype filter is set, the server
// can return any asset with that classification (e.g. a screenshot
// tagged "receipt" by the classifier). We still re-filter client-side
// by the doc-mime allowlist so images can't leak into the list.

"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ExternalLink,
  FileText,
  Loader2,
  X,
  ChevronRight,
} from "lucide-react";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { ListErrorState } from "../_components/list-states";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { cn } from "@/lib/utils";

const DOC_SUBTYPES = [
  "receipt",
  "contract",
  "letter",
  "report",
  "form",
  "document",
  "scan",
] as const;

const SUBTYPE_LABELS: Record<string, string> = {
  receipt: "Receipts",
  contract: "Contracts",
  letter: "Letters",
  report: "Reports",
  form: "Forms",
  document: "Documents",
  scan: "Scans",
};

const SUBTYPE_COLORS: Record<string, string> = {
  receipt: "text-green-600 dark:text-green-400",
  contract: "text-slate-600 dark:text-slate-400",
  letter: "text-pink-600 dark:text-pink-400",
  report: "text-teal-600 dark:text-teal-400",
  form: "text-cyan-600 dark:text-cyan-400",
  document: "text-muted-foreground",
  scan: "text-muted-foreground",
};

const DOC_MIME_TYPES = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  extractedText: string | null;
  classification: string | null;
  capturedAt: string | null;
  createdAt: string;
}

function isDocMime(mimeType: string): boolean {
  return DOC_MIME_TYPES.has(mimeType) || mimeType.startsWith("text/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Type rail (left column) ---------------------------------------------

function TypeRail({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<string, number>;
  selected: string | null;
  onSelect: (subtype: string | null) => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <aside className="w-44 shrink-0 border-r border-border px-2 py-3">
      <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Type
      </p>
      <button
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          selected === null
            ? "bg-primary/10 text-primary-text"
            : "text-foreground hover:bg-muted"
        )}
      >
        <span>All</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {total}
        </span>
      </button>
      {DOC_SUBTYPES.map((s) => {
        const count = counts[s] ?? 0;
        const active = selected === s;
        return (
          <button
            key={s}
            onClick={() => onSelect(s)}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              active
                ? "bg-primary/10 text-primary-text"
                : `${SUBTYPE_COLORS[s]} hover:bg-muted`
            )}
          >
            <span>{SUBTYPE_LABELS[s]}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          </button>
        );
      })}
    </aside>
  );
}

// ---- Doc list (middle column) --------------------------------------------

function DocRow({
  doc,
  active,
  onClick,
}: {
  doc: Asset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors",
        active ? "bg-primary/10" : "hover:bg-muted/50"
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileText className="h-4 w-4 text-orange-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {doc.filename}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {SUBTYPE_LABELS[doc.classification ?? ""] ?? doc.mimeType} ·{" "}
          {formatBytes(doc.sizeBytes)} ·{" "}
          {new Date(doc.capturedAt ?? doc.createdAt).toLocaleDateString()}
        </p>
        {doc.extractedText && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/70">
            {doc.extractedText.slice(0, 140)}
          </p>
        )}
      </div>
      {active && (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-primary-text" />
      )}
    </button>
  );
}

// ---- Persistent preview (right column) -----------------------------------

function PreviewPane({
  doc,
  onClose,
}: {
  doc: Asset | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setUrl(null);
      try {
        const r = await fetch(`/api/v1/assets/${doc.id}/url`);
        const d = (await r.json()) as { url?: string };
        if (!cancelled) setUrl(d.url ?? null);
      } catch {
        // ignore — preview falls back to "could not load"
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc?.id]);

  if (!doc) {
    return (
      <section className="hidden flex-1 flex-col items-center justify-center border-l border-border text-sm text-muted-foreground md:flex">
        <FileText className="mb-2 h-10 w-10 opacity-40" />
        Select a document to preview.
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col border-l border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-orange-400" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {doc.filename}
        </span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:text-foreground md:hidden"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : doc.mimeType === "application/pdf" && url ? (
          <iframe src={url} className="h-full w-full" title={doc.filename} />
        ) : doc.extractedText ? (
          <pre className="p-4 text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
            {doc.extractedText}
          </pre>
        ) : url ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <FileText className="h-16 w-16 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Preview not available for this file type.
            </p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <ExternalLink className="h-4 w-4" />
              Open file
            </a>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Could not load file.
            </p>
          </div>
        )}
      </div>

      {(doc.description || doc.extractedText) && (
        <footer className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {doc.description && <p className="truncate">{doc.description}</p>}
          <p>
            {formatBytes(doc.sizeBytes)} · {doc.mimeType}
          </p>
        </footer>
      )}
    </section>
  );
}

// ---- Page shell -----------------------------------------------------------

function DocumentsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("selected");

  const toolbar = useToolbarState({
    page: "documents",
    availableFilters: ["favorite"],
  });

  const [docs, setDocs] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [subtype, setSubtype] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const sp = new URLSearchParams();
        if (subtype) sp.set("subtype", subtype);
        const r = await fetch(`/api/v1/assets?${sp.toString()}`);
        if (!r.ok) throw new Error(`assets ${r.status}`);
        const d = (await r.json()) as { assets?: Asset[] };
        const list = (d.assets ?? []).filter((a) =>
          // Audit bug §UX-4 — even when a subtype filter is set we
          // re-check the mime so an image misclassified as "receipt"
          // can't leak into the documents list.
          isDocMime(a.mimeType)
        );
        setDocs(list);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [subtype, refreshKey]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of DOC_SUBTYPES) c[s] = 0;
    for (const d of docs) {
      if (d.classification && c[d.classification] != null) {
        c[d.classification]++;
      }
    }
    return c;
  }, [docs]);

  const visible = useMemo(() => {
    let list = docs;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter(
        (d) =>
          d.filename.toLowerCase().includes(needle) ||
          (d.description?.toLowerCase().includes(needle) ?? false) ||
          (d.extractedText?.toLowerCase().includes(needle) ?? false)
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
    } else if (toolbar.filters.sort === "largest") {
      list = [...list].sort((a, b) => b.sizeBytes - a.sizeBytes);
    } else {
      list = [...list].sort(
        (a, b) =>
          new Date(b.capturedAt ?? b.createdAt).getTime() -
          new Date(a.capturedAt ?? a.createdAt).getTime()
      );
    }
    return list;
  }, [docs, toolbar.filters.q, toolbar.filters.sort]);

  const selectedDoc = useMemo<Asset | null>(() => {
    if (!selectedId) return null;
    return docs.find((d) => d.id === selectedId) ?? null;
  }, [docs, selectedId]);

  const setSelected = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (id) sp.set("selected", id);
      else sp.delete("selected");
      const qs = sp.toString();
      router.replace(qs ? `/app/documents?${qs}` : "/app/documents");
    },
    [router, searchParams]
  );

  return (
    <div className="flex h-[calc(100vh-1rem)] flex-col">
      <AssetPageToolbar
        title="Documents"
        count={loading ? undefined : visible.length}
        toolbar={toolbar}
        searchPlaceholder="Search documents, OCR text…"
        sortOptions={["newest", "oldest", "name", "largest"]}
        filterKeys={["favorite"]}
        showDensity={false}
        showSelect={false}
      />

      <div className="flex flex-1 min-h-0">
        <TypeRail counts={counts} selected={subtype} onSelect={setSubtype} />

        <section className="flex w-96 max-w-md shrink-0 flex-col border-r border-border">
          <div className="flex-1 overflow-auto px-2 py-2">
            {error ? (
              <ListErrorState
                message="Couldn't load your documents. Check your connection and retry."
                onRetry={() => setRefreshKey((k) => k + 1)}
              />
            ) : loading ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                Loading documents…
              </p>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {toolbar.filters.q || subtype
                    ? "No documents match."
                    : "No documents yet."}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {visible.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    active={doc.id === selectedId}
                    onClick={() => setSelected(doc.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <PreviewPane doc={selectedDoc} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DocumentsContent />
    </Suspense>
  );
}
