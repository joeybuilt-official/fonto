// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, Zap, Loader2, Trash2, ChevronRight } from "lucide-react";

type SmartCollection = {
  id: string;
  name: string;
  query: Record<string, unknown>;
  createdAt: string;
};

const PRESET_QUERIES = [
  { label: "All receipts", query: { conditions: [{ field: "classification", op: "eq", value: "receipt" }], logic: "and" } },
  { label: "All contracts", query: { conditions: [{ field: "classification", op: "eq", value: "contract" }], logic: "and" } },
  { label: "All photos this year", query: { conditions: [{ field: "mimeType", op: "startsWith", value: "image/" }, { field: "createdAt", op: "gte", value: new Date(new Date().getFullYear(), 0, 1).toISOString() }], logic: "and" } },
  { label: "All PDFs", query: { conditions: [{ field: "mimeType", op: "eq", value: "application/pdf" }], logic: "and" } },
];

export default function SmartCollectionsPage() {
  const [collections, setCollections] = useState<SmartCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/smart-collections");
      if (res.ok) {
        const data = await res.json();
        setCollections(data.smartCollections ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const preset = PRESET_QUERIES.find((p) => p.label === selectedPreset);
    const res = await fetch("/api/v1/smart-collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), query: preset?.query ?? {} }),
    });
    if (res.ok) {
      setNewName("");
      setSelectedPreset(null);
      setShowForm(false);
      load();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this smart collection?")) return;
    await fetch(`/api/v1/smart-collections/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Smart Collections</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Saved searches that auto-update as assets change
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-border bg-card p-4 space-y-4">
          <h3 className="text-sm font-medium text-foreground">New smart collection</h3>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            autoFocus
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div>
            <p className="text-xs text-muted-foreground mb-2">Start from a preset:</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_QUERIES.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => { setSelectedPreset(p.label); setNewName(newName || p.label); }}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${selectedPreset === p.label ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-foreground px-3 py-2 text-sm text-background hover:bg-foreground/90">Create</button>
            <button type="button" onClick={() => { setShowForm(false); setSelectedPreset(null); }} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : collections.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Zap className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No smart collections yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create saved searches that stay up to date automatically</p>
        </div>
      ) : (
        <div className="space-y-2">
          {collections.map((sc) => (
            <div key={sc.id} className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-muted/20 transition-colors">
              <Zap className="h-4 w-4 shrink-0 text-amber-400" />
              <Link href={`/app/search?smartCollection=${sc.id}`} className="flex-1 min-w-0">
                <p className="font-medium text-foreground">{sc.name}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(sc.createdAt).toLocaleDateString()}
                </p>
              </Link>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <button
                onClick={() => handleDelete(sc.id)}
                className="hidden group-hover:flex items-center justify-center rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                aria-label="Delete smart collection"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
