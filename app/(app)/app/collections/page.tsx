"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";

interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

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
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setCollections((prev) => [...prev, data.collection]);
      setNewName("");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Collections</h1>
          <p className="text-sm text-muted-foreground mt-1">Organize assets into albums</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Collection
        </button>
      </div>

      {creating && (
        <form onSubmit={createCollection} className="flex gap-2">
          <input
            autoFocus
            type="text"
            placeholder="Collection name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => { setCreating(false); setNewName(""); }}
            className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading collections…</p>
      ) : collections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <FolderOpen className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No collections yet. Create one to organize your assets.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {collections.map((col) => (
            <div
              key={col.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 hover:bg-muted/40 transition-colors"
            >
              <FolderOpen className="h-6 w-6 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{col.name}</p>
                {col.description && (
                  <p className="truncate text-xs text-muted-foreground">{col.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
