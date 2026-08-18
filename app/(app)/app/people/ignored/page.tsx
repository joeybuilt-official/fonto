// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// #9 — Ignored review page.
//
// Lists everything the user has ignored across the three face surfaces —
// whole persons (junk clusters), individual "not a face" faces, and photos
// where all faces were ignored — each with a Restore (un-ignore) control:
//   - persons → PATCH /persons/:id { hidden: false }
//   - faces   → PATCH /faces/:id   { hidden: false }
//   - photos  → PATCH /assets/:id/faces-ignored { ignored: false }
// Data comes from GET /api/v1/faces/ignored.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Undo2, Users, ImageOff } from "lucide-react";

interface IgnoredPerson {
  id: string;
  name: string | null;
  instanceCount: number;
  coverFaceCropUrl: string | null;
}
interface IgnoredPhoto {
  id: string;
  filename: string;
}
interface IgnoredFace {
  id: string;
  assetId: string;
  faceCropUrl: string | null;
}
interface IgnoredData {
  persons: IgnoredPerson[];
  photos: IgnoredPhoto[];
  faces: IgnoredFace[];
}

// Resolves a relative crop API path (which returns { url }) to its signed
// object URL. Shared by the person + face thumbnails. Mirrors the resolver
// used by the people grid / person detail crops.
function CropThumb({
  cropUrl,
  alt,
  shape,
}: {
  cropUrl: string | null;
  alt: string;
  shape: "circle" | "square";
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale crop when cropUrl changes before refetch
    setSrc(null);
    if (!cropUrl) return;
    let cancelled = false;
    fetch(cropUrl)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setSrc(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cropUrl]);
  const radius = shape === "circle" ? "rounded-full" : "rounded-lg";
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        className={`aspect-square w-full ${radius} bg-muted/30 object-cover`}
      />
    );
  }
  return (
    <div
      className={`aspect-square w-full ${radius} bg-muted/30 flex items-center justify-center`}
    >
      <Users className="h-6 w-6 text-muted-foreground" />
    </div>
  );
}

export default function IgnoredPage() {
  const [data, setData] = useState<IgnoredData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Ids mid-restore — disabled + dimmed until the PATCH resolves.
  const [restoring, setRestoring] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/faces/ignored");
      if (!res.ok) {
        setError(`Failed to load ignored items (${res.status}).`);
        return;
      }
      const d = (await res.json()) as Partial<IgnoredData>;
      setData({
        persons: d.persons ?? [],
        photos: d.photos ?? [],
        faces: d.faces ?? [],
      });
    } catch {
      setError("Network error loading ignored items.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = useCallback((key: string, on: boolean) => {
    setRestoring((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Generic restore helper. Fires the un-ignore PATCH, optimistically drops
  // the row, restores it on failure.
  const restore = useCallback(
    async (
      key: string,
      url: string,
      body: Record<string, unknown>,
      drop: () => void,
      undrop: () => void
    ) => {
      mark(key, true);
      drop();
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          undrop();
          setError(`Restore failed (${res.status}).`);
        }
      } catch {
        undrop();
        setError("Network error during restore.");
      } finally {
        mark(key, false);
      }
    },
    [mark]
  );

  const restorePerson = useCallback(
    (p: IgnoredPerson) => {
      const snapshot = data;
      return restore(
        `person:${p.id}`,
        `/api/v1/persons/${p.id}`,
        { hidden: false },
        () =>
          setData((d) =>
            d ? { ...d, persons: d.persons.filter((x) => x.id !== p.id) } : d
          ),
        () => setData(snapshot)
      );
    },
    [data, restore]
  );

  const restorePhoto = useCallback(
    (ph: IgnoredPhoto) => {
      const snapshot = data;
      return restore(
        `photo:${ph.id}`,
        `/api/v1/assets/${ph.id}/faces-ignored`,
        { ignored: false },
        () =>
          setData((d) =>
            d ? { ...d, photos: d.photos.filter((x) => x.id !== ph.id) } : d
          ),
        () => setData(snapshot)
      );
    },
    [data, restore]
  );

  const restoreFace = useCallback(
    (f: IgnoredFace) => {
      const snapshot = data;
      return restore(
        `face:${f.id}`,
        `/api/v1/faces/${f.id}`,
        { hidden: false },
        () =>
          setData((d) =>
            d ? { ...d, faces: d.faces.filter((x) => x.id !== f.id) } : d
          ),
        () => setData(snapshot)
      );
    },
    [data, restore]
  );

  const empty =
    !!data &&
    data.persons.length === 0 &&
    data.photos.length === 0 &&
    data.faces.length === 0;

  return (
    <div className="space-y-6 px-4">
      <div className="space-y-2">
        <Link
          href="/app/people"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          People
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">Ignored</h1>
        <p className="text-sm text-muted-foreground">
          People, faces, and photos you&rsquo;ve hidden from face grouping.
          Restore anything to bring it back.
        </p>
      </div>

      {error && (
        <div className="rounded border border-destructive/30 bg-card px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}

      {!loading && empty && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing ignored. People, faces, or photos you ignore will show up
            here so you can restore them.
          </p>
        </div>
      )}

      {!loading && data && data.persons.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            Ignored people ({data.persons.length})
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {data.persons.map((p) => (
              <div key={p.id} className="space-y-2">
                <CropThumb
                  cropUrl={p.coverFaceCropUrl}
                  alt={p.name ?? "Unnamed person"}
                  shape="circle"
                />
                <div className="px-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {p.name ?? "Unnamed person"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.instanceCount} {p.instanceCount === 1 ? "face" : "faces"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void restorePerson(p)}
                  disabled={restoring.has(`person:${p.id}`)}
                  className="inline-flex w-full items-center justify-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Restore
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && data && data.faces.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            Ignored faces ({data.faces.length})
          </h2>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9">
            {data.faces.map((f) => (
              <div key={f.id} className="space-y-1.5">
                <CropThumb
                  cropUrl={f.faceCropUrl}
                  alt="Ignored face"
                  shape="square"
                />
                <button
                  type="button"
                  onClick={() => void restoreFace(f)}
                  disabled={restoring.has(`face:${f.id}`)}
                  className="inline-flex w-full items-center justify-center gap-1 rounded border border-border bg-background px-1.5 py-1 text-[11px] font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                >
                  <Undo2 className="h-3 w-3" />
                  Restore
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && data && data.photos.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            Photos with faces ignored ({data.photos.length})
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.photos.map((ph) => (
              <li
                key={ph.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm text-foreground" title={ph.filename}>
                    {ph.filename}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void restorePhoto(ph)}
                  disabled={restoring.has(`photo:${ph.id}`)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
