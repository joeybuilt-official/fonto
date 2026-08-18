// SPDX-License-Identifier: MIT
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
  useRef,
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
import { ListSkeleton } from "../_components/grid-skeleton";
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

// Subtype rail color hints — kept as a small distinguishing tint via the
// MD3 role palette rather than ad-hoc green/pink/teal. on-surface-variant
// is the neutral default; tertiary/secondary/primary lend a subtle accent
// where the older palette intentionally varied.
const SUBTYPE_COLORS: Record<string, string> = {
  receipt: "text-[var(--ft-color-tertiary)]",
  contract: "text-[var(--ft-color-on-surface-variant)]",
  letter: "text-[var(--ft-color-secondary)]",
  report: "text-[var(--ft-color-primary-text)]",
  form: "text-[var(--ft-color-tertiary)]",
  document: "text-[var(--ft-color-on-surface-variant)]",
  scan: "text-[var(--ft-color-on-surface-variant)]",
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
  // Below md the rail collapses to a horizontal, scrollable chip row so the
  // 3-pane shell doesn't overflow a phone viewport; md+ keeps the vertical
  // aside.
  return (
    <aside className="shrink-0 border-b border-[var(--ft-color-outline-variant)] px-2 py-2 md:w-44 md:border-b-0 md:border-r md:py-3">
      <p className="hidden px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)] md:block">
        Type
      </p>
      <div className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:gap-0.5 md:overflow-x-visible md:pb-0">
        <button
          onClick={() => onSelect(null)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-[var(--ft-shape-small)] px-2 py-1.5 text-left text-sm transition-colors md:w-full md:justify-between",
            selected === null
              ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
              : "text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)]"
          )}
        >
          <span>All</span>
          <span className="text-xs tabular-nums text-[var(--ft-color-on-surface-variant)]">
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
                "flex shrink-0 items-center gap-1.5 rounded-[var(--ft-shape-small)] px-2 py-1.5 text-left text-sm transition-colors md:w-full md:justify-between",
                active
                  ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
                  : `${SUBTYPE_COLORS[s]} hover:bg-[var(--ft-color-surface-container)]`
              )}
            >
              <span>{SUBTYPE_LABELS[s]}</span>
              <span className="text-xs tabular-nums text-[var(--ft-color-on-surface-variant)]">
                {count}
              </span>
            </button>
          );
        })}
      </div>
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
        "flex w-full items-center gap-3 rounded-[var(--ft-shape-small)] px-3 py-2.5 text-left transition-colors",
        active ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]" : "hover:bg-[var(--ft-color-surface-container)]/50"
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)]">
        <FileText className="h-4 w-4 text-[var(--ft-color-secondary)]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--ft-color-on-surface)]">
          {doc.filename}
        </p>
        <p className="truncate text-[11px] text-[var(--ft-color-on-surface-variant)]">
          {SUBTYPE_LABELS[doc.classification ?? ""] ?? doc.mimeType} ·{" "}
          {formatBytes(doc.sizeBytes)} ·{" "}
          {new Date(doc.capturedAt ?? doc.createdAt).toLocaleDateString()}
        </p>
        {doc.extractedText && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-[var(--ft-color-on-surface-variant)]/70">
            {doc.extractedText.slice(0, 140)}
          </p>
        )}
      </div>
      {active && (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ft-color-primary-text)]" />
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
      <section className="hidden flex-1 flex-col items-center justify-center border-l border-[var(--ft-color-outline-variant)] text-sm text-[var(--ft-color-on-surface-variant)] md:flex">
        <FileText className="mb-2 h-10 w-10 opacity-40" />
        Select a document to preview.
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col border-l border-[var(--ft-color-outline-variant)]">
      <header className="flex items-center gap-2 border-b border-[var(--ft-color-outline-variant)] px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-[var(--ft-color-secondary)]" />
        <span className="flex-1 truncate text-sm font-medium text-[var(--ft-color-on-surface)]">
          {doc.filename}
        </span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
            title="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <button
          onClick={onClose}
          className="rounded p-1 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)] md:hidden"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--ft-color-on-surface-variant)]" />
          </div>
        ) : doc.mimeType === "application/pdf" && url ? (
          <iframe src={url} className="h-full w-full" title={doc.filename} />
        ) : doc.extractedText ? (
          <pre className="p-4 text-sm text-[var(--ft-color-on-surface)] whitespace-pre-wrap font-mono leading-relaxed">
            {doc.extractedText}
          </pre>
        ) : url ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <FileText className="h-16 w-16 text-[var(--ft-color-on-surface-variant)]" />
            <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
              Preview not available for this file type.
            </p>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--ft-color-on-primary)] hover:brightness-95"
            >
              <ExternalLink className="h-4 w-4" />
              Open file
            </a>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
              Could not load file.
            </p>
          </div>
        )}
      </div>

      {(doc.description || doc.extractedText) && (
        <footer className="border-t border-[var(--ft-color-outline-variant)] px-3 py-2 text-xs text-[var(--ft-color-on-surface-variant)]">
          {doc.description && <p className="truncate">{doc.description}</p>}
          <p>
            {formatBytes(doc.sizeBytes)} · {doc.mimeType}
          </p>
        </footer>
      )}
    </section>
  );
}

// ---- infinite-scroll sentinel --------------------------------------------

/** IntersectionObserver tripwire that fires `onLoadMore` when it nears the
 *  bottom of its scroll container. `rootRef` MUST be the scrolling ancestor —
 *  a `root: null` (viewport) observer never fires for an element clipped
 *  inside an `overflow-auto` box. */
function ScrollSentinel({
  rootRef,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root: rootRef.current, rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore, rootRef]);

  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex items-center justify-center py-3">
      {loadingMore && (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--ft-color-on-surface-variant)]" />
      )}
    </div>
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

  const listScrollRef = useRef<HTMLDivElement>(null);

  const [docs, setDocs] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [subtype, setSubtype] = useState<string | null>(null);

  const buildQuery = useCallback(() => {
    const sp = new URLSearchParams();
    // `type=doc` = server-side doc-mime filter (route.ts) so we page through
    // documents only instead of serializing the whole workspace. Subtype is
    // NOT sent — it's applied client-side in `visible` so the rail counts stay
    // computed over the full doc set instead of collapsing to the picked type
    // (audit §UX P2).
    sp.set("type", "doc");
    sp.set("limit", "200");
    return sp;
  }, []);

  // First keyset page. The 200-row cap is a page, not the whole set — the
  // sentinel below the list walks the rest via the cursor. Rows are re-checked
  // against the doc-mime allowlist (audit bug §UX-4) so an image misclassified
  // as e.g. "receipt" can't leak into the list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const r = await fetch(`/api/v1/assets?${buildQuery().toString()}`);
        if (!r.ok) throw new Error(`assets ${r.status}`);
        const d = (await r.json()) as { assets?: Asset[]; cursor?: string | null };
        if (cancelled) return;
        // Audit bug §UX-4 — belt-and-braces: re-check the mime so an image
        // misclassified as "receipt" can't leak into the documents list.
        setDocs((d.assets ?? []).filter((a) => isDocMime(a.mimeType)));
        setCursor(d.cursor ?? null);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildQuery, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = buildQuery();
      sp.set("cursor", cursor);
      const r = await fetch(`/api/v1/assets?${sp.toString()}`);
      if (r.ok) {
        const d = (await r.json()) as { assets?: Asset[]; cursor?: string | null };
        setDocs((prev) => [...prev, ...(d.assets ?? []).filter((a) => isDocMime(a.mimeType))]);
        setCursor(d.cursor ?? null);
      }
    } catch {
      /* transient — sentinel retries on next scroll */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildQuery]);

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
    // Subtype narrowing happens here (not at fetch time) so the type-rail
    // counts above stay computed over the full doc set.
    if (subtype) list = list.filter((d) => d.classification === subtype);
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
  }, [docs, subtype, toolbar.filters.q, toolbar.filters.sort]);

  // The selected doc usually lives in the loaded set. When it doesn't — a
  // deep-linked `?selected=<id>` that isn't a doc-mime, or a row not in this
  // fetch — resolve it directly by id so the preview still renders instead of
  // falling back to the empty "Select a document" state.
  const inList = useMemo<Asset | null>(
    () => (selectedId ? docs.find((d) => d.id === selectedId) ?? null : null),
    [docs, selectedId]
  );
  const [fetchedDoc, setFetchedDoc] = useState<Asset | null>(null);
  useEffect(() => {
    if (!selectedId || inList) {
      setFetchedDoc(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/v1/assets/${selectedId}`);
        if (!r.ok) return;
        const d = (await r.json()) as { asset?: Asset };
        if (!cancelled && d.asset) setFetchedDoc(d.asset);
      } catch {
        // ignore — preview shows its own "could not load" fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, inList]);
  const selectedDoc = inList ?? fetchedDoc;

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

      {/* Below md: single column — the list and the preview swap on select
          (see the visibility toggles) instead of three fixed side-by-side
          panes, which would overflow a phone viewport. */}
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row">
        <TypeRail counts={counts} selected={subtype} onSelect={setSubtype} />

        <section
          className={cn(
            "w-full min-h-0 flex-1 flex-col border-r border-[var(--ft-color-outline-variant)] md:w-96 md:max-w-md md:flex-none md:shrink-0",
            selectedId ? "hidden md:flex" : "flex"
          )}
        >
          <div ref={listScrollRef} className="flex-1 overflow-auto px-2 py-2">
            {error ? (
              <ListErrorState
                message="Couldn't load your documents. Check your connection and retry."
                onRetry={() => setRefreshKey((k) => k + 1)}
              />
            ) : loading ? (
              <ListSkeleton count={7} />
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <FileText className="h-8 w-8 text-[var(--ft-color-on-surface-variant)]" />
                <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
                  {toolbar.filters.q || subtype
                    ? "No documents match."
                    : "No documents yet."}
                </p>
              </div>
            ) : (
              <>
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
                <ScrollSentinel
                  rootRef={listScrollRef}
                  onLoadMore={loadMore}
                  hasMore={cursor !== null}
                  loadingMore={loadingMore}
                />
              </>
            )}
          </div>
        </section>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            selectedId ? "flex" : "hidden md:flex"
          )}
        >
          <PreviewPane doc={selectedDoc} onClose={() => setSelected(null)} />
        </div>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--ft-color-on-surface-variant)] py-4">Loading…</div>}>
      <DocumentsContent />
    </Suspense>
  );
}
