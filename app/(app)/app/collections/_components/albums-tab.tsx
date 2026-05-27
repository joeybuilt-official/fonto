// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — Albums sub-tab inside /app/collections.
//
// Lifted verbatim from the pre-Phase-2 `app/(app)/app/collections/page.tsx`
// CollectionsContent body. No behavior change.
"use client";

import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Plus, X } from "lucide-react";
import Link from "next/link";
import { AssetPageToolbar } from "../../_components/asset-page-toolbar";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  assetCount?: number;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function AlbumsTab() {
  const toolbar = useToolbarState({
    page: "collections",
    availableFilters: [],
  });

  const [collections, setCollections] = useState<Collection[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/v1/collections");
        const d = r.ok ? ((await r.json()) as { collections?: Collection[] }) : { collections: [] };
        const list = d.collections ?? [];
        setCollections(list);
        if (list.length === 0) return;
        const firstAssets = await Promise.all(
          list.map(async (c) => {
            try {
              const rr = await fetch(`/api/v1/collections/${c.id}/assets?limit=1`);
              if (!rr.ok) return null;
              const dd = (await rr.json()) as { assets?: { id: string }[] };
              const firstId = dd.assets?.[0]?.id ?? null;
              return firstId ? { collectionId: c.id, assetId: firstId } : null;
            } catch {
              return null;
            }
          })
        );
        const mappings = firstAssets.filter((x): x is { collectionId: string; assetId: string } => x !== null);
        if (mappings.length === 0) return;
        const urlsRes = await fetch("/api/v1/assets/urls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: mappings.map((m) => m.assetId),
            variant: "thumb",
          }),
        });
        const urlsData = (await urlsRes.json()) as { urls?: Record<string, string> };
        const byCollection: Record<string, string> = {};
        for (const m of mappings) {
          const url = urlsData.urls?.[m.assetId];
          if (url) byCollection[m.collectionId] = url;
        }
        setCoverUrls(byCollection);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const visible = useMemo(() => {
    let list = collections;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.description.toLowerCase().includes(needle)
      );
    }
    if (toolbar.filters.sort === "oldest") {
      list = [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } else if (toolbar.filters.sort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      list = [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }
    return list;
  }, [collections, toolbar.filters.q, toolbar.filters.sort]);

  async function createCollection(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch("/api/v1/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() }),
    });
    if (res.ok) {
      const data = (await res.json()) as { collection: Collection };
      setCollections((prev) => [...prev, data.collection]);
      setNewName("");
      setNewDesc("");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Albums"
        count={loading ? undefined : visible.length}
        toolbar={toolbar}
        searchPlaceholder="Search albums…"
        sortOptions={["newest", "oldest", "name"]}
        showDensity={false}
        showSelect={false}
        primaryAction={{
          label: "New",
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: () => setCreating(true),
        }}
      />

      <div className="px-4 space-y-4">
        {creating && (
          <form
            onSubmit={createCollection}
            className="rounded-xl border border-border bg-card p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">New Album</p>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setNewDesc("");
                }}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              autoFocus
              type="text"
              placeholder="Album name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!newName.trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setNewDesc("");
                }}
                className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground py-4">Loading albums…</p>
        ) : visible.length === 0 && !toolbar.filters.q ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No albums yet. Create one to organize your assets.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No matches.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {visible.map((col) => (
              <Link
                key={col.id}
                href={`/app/collections/${col.id}`}
                className="group overflow-hidden rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all"
              >
                {coverUrls[col.id] ? (
                  <div className="aspect-video w-full overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={coverUrls[col.id]}
                      alt={`${col.name} cover`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  </div>
                ) : (
                  <div className="aspect-video w-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                    <FolderOpen className="h-8 w-8 text-primary/40" />
                  </div>
                )}
                <div className="p-3">
                  <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                    {col.name}
                  </p>
                  {col.description && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {col.description}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {formatDate(col.createdAt)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
