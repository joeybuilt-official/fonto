// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — People grid.
//
// UX-3 sweep: shared toolbar at top. PrimaryAction = "Run clustering"
// (was the only prior page action; keeps the existing endpoint hit and
// toast state). FaceCrop card unchanged. Audit §4 calls for a
// needs-review bucket + drag-merge + inline rename — deferred.
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Users, Play } from "lucide-react";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

interface PersonGridEntry {
  id: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
  coverAssetId: string | null;
  coverBbox: { x: number; y: number; w: number; h: number } | null;
}

function FaceCrop({ entry }: { entry: PersonGridEntry }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!entry.coverAssetId) return;
    let cancelled = false;
    fetch(`/api/v1/assets/${entry.coverAssetId}/url?variant=preview`)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setUrl(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry.coverAssetId]);

  if (!url || !entry.coverBbox) {
    return (
      <div className="aspect-square rounded-lg bg-muted/30 flex items-center justify-center">
        <Users className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  const { x, y, w, h } = entry.coverBbox;
  const scale = 1 / Math.max(w, h);
  const bgSize = `${scale * 100}%`;
  const bgPositionX = `${-(x * scale * 100)}%`;
  const bgPositionY = `${-(y * scale * 100)}%`;

  return (
    <div
      className="aspect-square rounded-lg bg-muted/30 overflow-hidden"
      style={{
        backgroundImage: `url(${url})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: bgSize,
        backgroundPositionX: bgPositionX,
        backgroundPositionY: bgPositionY,
      }}
      role="img"
      aria-label={entry.name ?? "Unnamed person"}
    />
  );
}

function PeopleContent() {
  const toolbar = useToolbarState({
    page: "people",
    availableFilters: [],
  });

  const [persons, setPersons] = useState<PersonGridEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [clustering, setClustering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/persons");
      if (!res.ok) {
        setError(`Failed to load people (${res.status}).`);
        setPersons([]);
        return;
      }
      const data = (await res.json()) as { persons: PersonGridEntry[] };
      setPersons(data.persons ?? []);
    } catch {
      setError("Network error loading people.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCluster = useCallback(async () => {
    setClustering(true);
    setToast(null);
    try {
      const res = await fetch("/api/v1/faces/cluster", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setToast(`Clustering failed: ${body.error ?? res.status}`);
        return;
      }
      const data = (await res.json()) as {
        stats: { created: number; updated: number; noise: number };
      };
      setToast(
        `Clustered — ${data.stats.created} new, ${data.stats.updated} updated, ${data.stats.noise} noise.`
      );
      await load();
    } catch {
      setToast("Network error during clustering.");
    } finally {
      setClustering(false);
    }
  }, [load]);

  const visible = useMemo(() => {
    let list = persons;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter((p) =>
        (p.name ?? "unnamed").toLowerCase().includes(needle)
      );
    }
    if (toolbar.filters.sort === "name") {
      list = [...list].sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? "")
      );
    } else if (toolbar.filters.sort === "oldest") {
      // "oldest" → fewest faces first (smallest cluster). Useful for
      // finding outliers / clusters that may need merging.
      list = [...list].sort((a, b) => a.instanceCount - b.instanceCount);
    } else {
      // Default newest = most-active = largest cluster.
      list = [...list].sort((a, b) => b.instanceCount - a.instanceCount);
    }
    return list;
  }, [persons, toolbar.filters.q, toolbar.filters.sort]);

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="People"
        count={loading ? undefined : visible.length}
        toolbar={toolbar}
        searchPlaceholder="Search people by name…"
        sortOptions={["newest", "oldest", "name"]}
        showDensity={false}
        showSelect={false}
        primaryAction={{
          label: clustering ? "Clustering…" : "Run clustering",
          icon: clustering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          ),
          variant: "outline",
          onClick: () => void runCluster(),
        }}
      />

      <div className="px-4 space-y-4">
        {toast && (
          <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            {toast}
          </div>
        )}

        {loading && (
          <p className="text-sm text-muted-foreground">Loading people…</p>
        )}

        {error && !loading && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && persons.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No people yet. Upload photos with faces and click
              &ldquo;Run clustering&rdquo; to build cluster cards.
            </p>
          </div>
        )}

        {!loading && !error && persons.length > 0 && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">No matches.</p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {visible.map((p) => (
            <Link
              key={p.id}
              href={`/app/people/${p.id}`}
              className="group block space-y-2"
            >
              <FaceCrop entry={p} />
              <div className="px-1">
                <div className="truncate text-sm font-medium text-foreground group-hover:underline">
                  {p.name ?? "Unnamed person"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.instanceCount} {p.instanceCount === 1 ? "face" : "faces"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <PeopleContent />
    </Suspense>
  );
}
