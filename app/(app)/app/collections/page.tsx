"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Plus, X, Image as ImageIcon, Loader2 } from "lucide-react";
import Link from "next/link";

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

function CollectionCover({ collectionId }: { collectionId: string }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/collections/${collectionId}/assets`)
      .then((r) => r.json())
      .then(async (d) => {
        if (cancelled) return;
        const firstAsset = d.assets?.[0];
        if (!firstAsset) return;
        const res = await fetch(`/api/v1/assets/${firstAsset.id}/url`);
        if (cancelled) return;
        const data = await res.json();
        setCoverUrl(data.url ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [collectionId]);

  if (!coverUrl) {
    return (
      <div className="aspect-video w-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
        <FolderOpen className="h-8 w-8 text-primary/40" />
      </div>
    );
  }

  return (
    <div className="aspect-video w-full overflow-hidden bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={coverUrl}
        alt="Collection cover"
        className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        loading="lazy"
      />
    </div>
  );
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  useEffect(() => {
    fetch("/api/v1/collections")
      .then((r) => r.ok ? r.json() : { collections: [] })
      .then((d) => setCollections(d.collections ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function createCollection(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch("/api/v1/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setCollections((prev) => [...prev, data.collection]);
      setNewName("");
      setNewDesc("");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Collections</h1>
          <p className="text-sm text-muted-foreground mt-1">Organize assets into albums</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Collection
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <form onSubmit={createCollection} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">New Collection</p>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(""); setNewDesc(""); }}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <input
            autoFocus
            type="text"
            placeholder="Collection name"
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
              onClick={() => { setCreating(false); setNewName(""); setNewDesc(""); }}
              className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Collections grid */}
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading collections...
        </div>
      ) : collections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FolderOpen className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No collections yet. Create one to organize your assets.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {collections.map((col) => (
            <Link
              key={col.id}
              href={`/app/collections/${col.id}`}
              className="group overflow-hidden rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all"
            >
              <CollectionCover collectionId={col.id} />
              <div className="p-3">
                <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                  {col.name}
                </p>
                {col.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{col.description}</p>
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
  );
}
