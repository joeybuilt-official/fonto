// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { ConfirmButton } from "@/components/confirm-button";
import { type Asset } from "../_components/photo-card";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { AssetGrid } from "../_components/asset-grid";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

// Trash extends the shared Asset shape with the trash-only deletedAt
// column the list endpoint surfaces for lifecycle=trashed rows.
interface TrashedAsset extends Asset {
  deletedAt?: string | null;
}

// Stable identity so it doesn't defeat useToolbarState's internal useMemo
// (a fresh object literal per render would change filters' identity too).
const TRASH_TOOLBAR_DEFAULTS = { sort: "oldest", viewMode: "list" } as const;

function BulkBar({
  count,
  onRestore,
  onDelete,
  onClear,
}: {
  count: number;
  onRestore: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 flex items-center gap-2 rounded-[var(--ft-shape-large)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-high)]/95 backdrop-blur px-4 py-2.5 shadow-[var(--ft-elev-3)]">
      <span className="text-sm font-medium text-[var(--ft-color-on-surface)] mr-2">
        {count} {count === 1 ? "item" : "items"} selected
      </span>
      <button
        onClick={onRestore}
        className="flex items-center gap-1.5 rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)] px-3 py-1.5 text-xs font-medium text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-secondary-container)] hover:text-[var(--ft-color-on-secondary-container)] transition-colors"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Restore
      </button>
      <ConfirmButton
        onConfirm={onDelete}
        className="flex items-center gap-1.5 rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)] px-3 py-1.5 text-xs font-medium text-[var(--ft-color-error)] hover:bg-[var(--ft-color-error-container)] transition-colors"
        armedClassName="bg-[var(--ft-color-error-container)] ring-1 ring-[var(--ft-color-error)]"
        confirmLabel={
          <span className="flex items-center gap-1 font-bold">
            <Trash2 className="h-3.5 w-3.5" />
            Delete {count} forever?
          </span>
        }
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete forever
      </ConfirmButton>
      <button
        onClick={onClear}
        className="rounded-[var(--ft-shape-small)] p-1.5 text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)] transition-colors"
        title="Clear selection"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function TrashContent() {
  const toolbar = useToolbarState({
    page: "trash",
    availableFilters: ["mime", "favorite"],
    // Trash defaults to oldest-first so users see the about-to-purge rows
    // up top once the retention countdown lands.
    defaults: TRASH_TOOLBAR_DEFAULTS,
  });

  const [rawItems, setRawItems] = useState<TrashedAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const buildQuery = useCallback(() => {
    const sp = new URLSearchParams();
    sp.set("lifecycle", "trashed");
    sp.set("limit", "200");
    if (toolbar.filters.mime) sp.set("mime", toolbar.filters.mime);
    if (toolbar.filters.favorite) sp.set("favorite", "1");
    return sp;
  }, [toolbar.filters.mime, toolbar.filters.favorite]);

  // First keyset page (created-DESC). The 200-row cap is a page, not the whole
  // trash — load-more-on-scroll walks the rest via the cursor.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/v1/assets?${buildQuery().toString()}`);
        const d = (await r.json()) as { assets?: TrashedAsset[]; cursor?: string | null };
        if (cancelled) return;
        setRawItems(d.assets ?? []);
        setCursor(d.cursor ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildQuery]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = buildQuery();
      sp.set("cursor", cursor);
      const r = await fetch(`/api/v1/assets?${sp.toString()}`);
      if (r.ok) {
        const d = (await r.json()) as { assets?: TrashedAsset[]; cursor?: string | null };
        setRawItems((prev) => [...prev, ...(d.assets ?? [])]);
        setCursor(d.cursor ?? null);
      }
    } catch {
      /* transient — sentinel retries on next scroll */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildQuery]);

  // Client-side sort + text search over the loaded window.
  const items = useMemo(() => {
    let list = rawItems;
    if (toolbar.filters.sort === "oldest") {
      list = [...list].sort(
        (a, b) =>
          new Date(a.deletedAt ?? a.createdAt).getTime() -
          new Date(b.deletedAt ?? b.createdAt).getTime()
      );
    } else if (toolbar.filters.sort === "name") {
      list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
    } else {
      list = [...list].sort(
        (a, b) =>
          new Date(b.deletedAt ?? b.createdAt).getTime() -
          new Date(a.deletedAt ?? a.createdAt).getTime()
      );
    }
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter((a) => a.filename.toLowerCase().includes(needle));
    }
    return list;
  }, [rawItems, toolbar.filters.sort, toolbar.filters.q]);

  async function restoreOne(assetId: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/v1/assets/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restore: true }),
      });
      if (!r.ok) return false;
      setRawItems((prev) => prev.filter((a) => a.id !== assetId));
      return true;
    } catch {
      return false;
    }
  }

  async function deleteOne(assetId: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/v1/assets/${assetId}`, { method: "DELETE" });
      if (!r.ok) return false;
      setRawItems((prev) => prev.filter((a) => a.id !== assetId));
      return true;
    } catch {
      return false;
    }
  }

  async function bulkRestore() {
    setActionError(null);
    const ids = Array.from(toolbar.selectedIds);
    const results = await Promise.all(ids.map(restoreOne));
    toolbar.clearSelection();
    const failed = results.filter((ok) => !ok).length;
    if (failed > 0) {
      setActionError(`Couldn't restore ${failed} item${failed === 1 ? "" : "s"}. Try again.`);
    }
  }

  async function bulkDelete() {
    setActionError(null);
    const ids = Array.from(toolbar.selectedIds);
    const results = await Promise.all(ids.map(deleteOne));
    toolbar.clearSelection();
    const failed = results.filter((ok) => !ok).length;
    if (failed > 0) {
      setActionError(`Couldn't delete ${failed} item${failed === 1 ? "" : "s"}. Try again.`);
    }
  }

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Trash"
        count={items.length}
        toolbar={toolbar}
        searchPlaceholder="Search trash…"
        sortOptions={["newest", "oldest", "name"]}
        filterKeys={["mime", "favorite"]}
        viewModes={["grid", "list"]}
        showDensity
        showSelect
      />

      {actionError && (
        <p className="mx-4 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-error)]/40 bg-[var(--ft-color-error-container)] px-3 py-2 text-sm text-[var(--ft-color-on-error-container)]">
          {actionError}
        </p>
      )}

      {loading ? (
        <p className="px-4 py-4 text-sm text-[var(--ft-color-on-surface-variant)]">Loading…</p>
      ) : items.length === 0 && !toolbar.filters.q && !toolbar.filters.mime ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Trash2 className="h-10 w-10 text-[var(--ft-color-on-surface-variant)]" />
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">Trash is empty.</p>
        </div>
      ) : (
        <div className="px-4">
          <AssetGrid
            assets={items}
            toolbar={toolbar}
            onAssetClick={(_id) => undefined}
            onLoadMore={loadMore}
            hasMore={cursor !== null}
            loadingMore={loadingMore}
          />
        </div>
      )}

      {/* Per-row inline actions live inside the bulk bar — trash rows use
          select-then-act rather than hover-menus, which is safer for the
          delete-forever action. */}
      <BulkBar
        count={toolbar.selectedIds.size}
        onRestore={bulkRestore}
        onDelete={bulkDelete}
        onClear={() => toolbar.clearSelection()}
      />
    </div>
  );
}

export default function TrashPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--ft-color-on-surface-variant)] py-4">Loading…</div>}>
      <TrashContent />
    </Suspense>
  );
}
