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
  // Phase 2 (faces/UX) — dedicated square crop for the cover face (sharp,
  // centered). NULL until the crop is generated; we then fall back to the
  // signed preview-CSS-zoom path so the grid is never blank.
  coverFaceCropKey: string | null;
  coverFaceCropUrl: string | null;
}

// Phase 2 (faces/UX) — uniform circular face tile. Prefers the dedicated
// face-crop derivative (`coverFaceCropUrl`, served via the signed
// variant=face path) rendered object-cover in a circle. Until the crop is
// backfilled it falls back to the legacy preview + bbox CSS-zoom, then to a
// neutral placeholder so the tile is always a clean circle.
function FaceCrop({ entry }: { entry: PersonGridEntry }) {
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const [cropFailed, setCropFailed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Resolve the signed face-crop URL (the API returns a relative API path
  // that itself redirects to / returns a signed object URL).
  useEffect(() => {
    setCropUrl(null);
    setCropFailed(false);
    if (!entry.coverFaceCropUrl) return;
    let cancelled = false;
    fetch(entry.coverFaceCropUrl)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setCropUrl(d.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setCropFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.coverFaceCropUrl]);

  // Fallback: only fetch the preview (for the legacy CSS-zoom) when there's
  // no crop derivative yet, or the crop URL failed to resolve.
  const needPreviewFallback =
    (!entry.coverFaceCropUrl || cropFailed) && !!entry.coverAssetId;
  useEffect(() => {
    if (!needPreviewFallback || !entry.coverAssetId) return;
    let cancelled = false;
    fetch(`/api/v1/assets/${entry.coverAssetId}/url?variant=preview`)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setPreviewUrl(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needPreviewFallback, entry.coverAssetId]);

  // Preferred: the sharp dedicated crop, object-cover in a circle.
  if (cropUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={cropUrl}
        alt={entry.name ?? "Unnamed person"}
        className="aspect-square w-full rounded-full bg-muted/30 object-cover"
      />
    );
  }

  // Fallback: legacy preview + bbox CSS-zoom, still rendered as a circle.
  if (previewUrl && entry.coverBbox) {
    const { x, y, w, h } = entry.coverBbox;
    const scale = 1 / Math.max(w, h);
    return (
      <div
        className="aspect-square rounded-full bg-muted/30 overflow-hidden"
        style={{
          backgroundImage: `url(${previewUrl})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${scale * 100}%`,
          backgroundPositionX: `${-(x * scale * 100)}%`,
          backgroundPositionY: `${-(y * scale * 100)}%`,
        }}
        role="img"
        aria-label={entry.name ?? "Unnamed person"}
      />
    );
  }

  return (
    <div className="aspect-square rounded-full bg-muted/30 flex items-center justify-center">
      <Users className="h-8 w-8 text-muted-foreground" />
    </div>
  );
}

// Phase 2 (faces/UX) — skeleton grid (animate-pulse) shown while the people
// list loads, replacing the bare "Loading…" full-page text.
function PeopleSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="aspect-square animate-pulse rounded-full bg-muted/40" />
          <div className="px-1 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted/40" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/30" />
          </div>
        </div>
      ))}
    </div>
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

        {loading && <PeopleSkeleton />}

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

        {!loading && (
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
        )}
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
