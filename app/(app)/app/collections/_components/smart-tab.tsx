// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — Smart sub-tab inside /app/collections.
//
// Lifted verbatim from the pre-Phase-2 `app/(app)/app/smart-collections/page.tsx`
// SmartCollectionsContent body. No behavior change.
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Plus, Zap, Loader2, Trash2, ChevronRight } from "lucide-react";
import { AssetPageToolbar } from "../../_components/asset-page-toolbar";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

type SmartCollection = {
  id: string;
  name: string;
  query: Record<string, unknown>;
  createdAt: string;
};

type PersonOption = { id: string; name: string | null };

const PRESET_QUERIES = [
  { label: "All receipts", query: { conditions: [{ field: "classification", op: "eq", value: "receipt" }], logic: "and" } },
  { label: "All contracts", query: { conditions: [{ field: "classification", op: "eq", value: "contract" }], logic: "and" } },
  { label: "All photos this year", query: { conditions: [{ field: "mimeType", op: "startsWith", value: "image/" }, { field: "createdAt", op: "gte", value: new Date(new Date().getFullYear(), 0, 1).toISOString() }], logic: "and" } },
  { label: "All PDFs", query: { conditions: [{ field: "mimeType", op: "eq", value: "application/pdf" }], logic: "and" } },
];

export function SmartTab() {
  const toolbar = useToolbarState({
    page: "smart-collections",
    availableFilters: [],
  });
  const [collections, setCollections] = useState<SmartCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const [clipText, setClipText] = useState("");
  const [hasFaces, setHasFaces] = useState(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [dominantColor, setDominantColor] = useState("");
  const [colorTolerance, setColorTolerance] = useState(30);
  const [personOptions, setPersonOptions] = useState<PersonOption[]>([]);
  const [personsAvailable, setPersonsAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/persons");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { persons?: PersonOption[] };
        setPersonsAvailable(true);
        setPersonOptions(Array.isArray(data.persons) ? data.persons : []);
      } catch {
        // endpoint not deployed yet — hide the control.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function resetFacets() {
    setClipText("");
    setHasFaces(false);
    setSelectedPersonIds([]);
    setDominantColor("");
    setColorTolerance(30);
  }

  function togglePerson(id: string) {
    setSelectedPersonIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

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
    const query: Record<string, unknown> = { ...(preset?.query ?? {}) };
    const clipTrimmed = clipText.trim();
    if (clipTrimmed.length > 0) query.clipText = clipTrimmed;
    if (selectedPersonIds.length > 0) query.personIds = selectedPersonIds;
    if (hasFaces) query.hasFaces = true;
    if (/^#[0-9a-fA-F]{6}$/.test(dominantColor)) {
      query.dominantColor = dominantColor.toLowerCase();
      if (colorTolerance !== 30) query.tolerance = colorTolerance;
    }
    const res = await fetch("/api/v1/smart-collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), query }),
    });
    if (res.ok) {
      setNewName("");
      setSelectedPreset(null);
      resetFacets();
      setShowForm(false);
      load();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this smart collection?")) return;
    await fetch(`/api/v1/smart-collections/${id}`, { method: "DELETE" });
    load();
  }

  const visible = useMemo(() => {
    let list = collections;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(needle));
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

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Smart Collections"
        count={loading ? undefined : visible.length}
        toolbar={toolbar}
        searchPlaceholder="Search smart collections…"
        sortOptions={["newest", "oldest", "name"]}
        showDensity={false}
        showSelect={false}
        primaryAction={{
          label: "New",
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: () => setShowForm(true),
        }}
      />

      <div className="px-4 space-y-4">
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
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Optional facets (AND-ed with the preset above):
            </p>

            <div className="space-y-1">
              <label htmlFor="sc-clip-text" className="block text-xs font-medium text-foreground">
                Visual search
              </label>
              <input
                id="sc-clip-text"
                type="text"
                value={clipText}
                onChange={(e) => setClipText(e.target.value)}
                placeholder="e.g. dog on beach, snow-capped mountain, kitchen counter"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Embedded with CLIP at query time. Requires the vision sidecar.
              </p>
            </div>

            {personsAvailable && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-foreground">
                  People
                </label>
                {personOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No tagged people yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {personOptions.map((p) => {
                      const active = selectedPersonIds.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => togglePerson(p.id)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            active
                              ? "bg-foreground text-background border-foreground"
                              : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                          }`}
                        >
                          {p.name ?? "Unnamed"}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {personsAvailable && (
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={hasFaces}
                  onChange={(e) => setHasFaces(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border"
                />
                Only assets with detected faces
              </label>
            )}

            <div className="space-y-1">
              <label htmlFor="sc-color" className="block text-xs font-medium text-foreground">
                Dominant color
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="sc-color"
                  type="color"
                  value={dominantColor || "#888888"}
                  onChange={(e) => setDominantColor(e.target.value)}
                  className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
                  aria-label="Pick dominant color"
                />
                <input
                  type="text"
                  value={dominantColor}
                  onChange={(e) => setDominantColor(e.target.value)}
                  placeholder="#ff5500"
                  className="w-28 rounded-lg border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {dominantColor && (
                  <button
                    type="button"
                    onClick={() => setDominantColor("")}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              {dominantColor && (
                <div className="pt-1">
                  <label htmlFor="sc-tolerance" className="block text-xs text-muted-foreground">
                    Tolerance: ΔE {colorTolerance}
                  </label>
                  <input
                    id="sc-tolerance"
                    type="range"
                    min={5}
                    max={80}
                    step={1}
                    value={colorTolerance}
                    onChange={(e) => setColorTolerance(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-foreground px-3 py-2 text-sm text-background hover:bg-foreground/90">Create</button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setSelectedPreset(null);
                resetFacets();
              }}
              className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : visible.length === 0 && !toolbar.filters.q ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Zap className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No smart collections yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create saved searches that stay up to date automatically</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches.</p>
      ) : (
        <div className="space-y-2">
          {visible.map((sc) => (
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
    </div>
  );
}
