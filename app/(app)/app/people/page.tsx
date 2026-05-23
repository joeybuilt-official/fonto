// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — People grid.
//
// Lists every clustered identity for the caller's workspace. Each card
// shows the cover-face crop (rendered from the bbox over the asset's
// preview), the name (or "Unnamed") and the instance count.
//
// "Run clustering" triggers `POST /api/v1/faces/cluster` — owner-only on
// the server, but we don't gate it in the UI; non-owners just see a 403
// toast and can ignore the button.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Users, Play } from "lucide-react";

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

  // Render the bbox by oversizing the background image and offsetting it.
  // The bbox is normalised (0..1) — scaling the image so the bbox fills the
  // square is `1 / bbox.w` along x (we pick the smaller of x/y so the crop
  // never undershoots).
  const { x, y, w, h } = entry.coverBbox;
  const scale = 1 / Math.max(w, h);
  const bgSize = `${scale * 100}%`;
  // Translate so the bbox top-left lines up with (0, 0); negative offsets
  // shift the image up + left.
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

export default function PeoplePage() {
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
    load();
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">People</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Faces clustered into identities. Run clustering to refresh after
            new uploads.
          </p>
        </div>
        <button
          type="button"
          onClick={runCluster}
          disabled={clustering}
          className="inline-flex items-center gap-2 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
        >
          {clustering ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          Run clustering
        </button>
      </div>

      {toast && (
        <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
          {toast}
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground">Loading people…</p>
      )}

      {error && !loading && (
        <p className="text-sm text-red-500">{error}</p>
      )}

      {!loading && !error && persons.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No people yet. Upload photos with faces and click
            &ldquo;Run clustering&rdquo; to build cluster cards.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {persons.map((p) => (
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
  );
}
