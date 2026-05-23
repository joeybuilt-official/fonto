// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.1 — Person detail page.
//
// Lets the user:
//   - rename the person inline (PATCH /persons/:id { name }),
//   - browse every face (paginated GET /persons/:id/faces) as bbox crops,
//   - hide / detach individual faces (PATCH /faces/:id),
//   - merge into another person (POST /persons/:id/merge),
//   - split selected faces out into a new person (POST /persons/:id/split).
"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Check, EyeOff, Users } from "lucide-react";

interface Person {
  id: string;
  workspaceId: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
}

interface FaceAssetMeta {
  id: string;
  filename: string;
  mimeType: string;
  previewUrl: string;
}

interface FaceEntry {
  id: string;
  assetId: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  confidence: number;
  hidden: boolean;
  asset: FaceAssetMeta;
}

interface PersonGridEntry {
  id: string;
  name: string | null;
  instanceCount: number;
}

function FaceCropBox({
  face,
  selected,
  onToggleSelect,
}: {
  face: FaceEntry;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(face.asset.previewUrl)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setUrl(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [face.asset.previewUrl]);

  let style: React.CSSProperties = {};
  if (url && face.bbox) {
    const { x, y, w, h } = face.bbox;
    const scale = 1 / Math.max(w, h);
    style = {
      backgroundImage: `url(${url})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${scale * 100}%`,
      backgroundPositionX: `${-(x * scale * 100)}%`,
      backgroundPositionY: `${-(y * scale * 100)}%`,
    };
  }

  return (
    <button
      type="button"
      onClick={() => onToggleSelect(face.id)}
      className={`relative aspect-square rounded-lg overflow-hidden bg-muted/30 transition ring-offset-2 ring-offset-background ${
        selected ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-border"
      }`}
      style={style}
      aria-pressed={selected}
      aria-label={`Face on ${face.asset.filename}`}
    >
      {face.hidden && (
        <span className="absolute right-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
          hidden
        </span>
      )}
      {selected && (
        <span className="absolute left-1 top-1 rounded-full bg-primary text-primary-foreground p-0.5">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}

export default function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [person, setPerson] = useState<Person | null>(null);
  const [faces, setFaces] = useState<FaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);

  // Merge picker
  const [showMerge, setShowMerge] = useState(false);
  const [allPersons, setAllPersons] = useState<PersonGridEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, fRes] = await Promise.all([
        fetch(`/api/v1/persons/${id}`),
        fetch(`/api/v1/persons/${id}/faces?limit=200`),
      ]);
      if (!pRes.ok) {
        setError(`Failed to load person (${pRes.status}).`);
        return;
      }
      const pData = (await pRes.json()) as { person: Person };
      setPerson(pData.person);
      setName(pData.person.name ?? "");
      if (fRes.ok) {
        const fData = (await fRes.json()) as { faces: FaceEntry[] };
        setFaces(fData.faces ?? []);
      }
    } catch {
      setError("Network error loading person.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const saveName = useCallback(async () => {
    if (!person) return;
    setSavingName(true);
    try {
      const trimmed = name.trim();
      const res = await fetch(`/api/v1/persons/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed === "" ? null : trimmed }),
      });
      if (res.ok) {
        const data = (await res.json()) as { person: Person };
        setPerson(data.person);
        setName(data.person.name ?? "");
      }
    } finally {
      setSavingName(false);
    }
  }, [person, name]);

  const toggleSelect = useCallback((faceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  }, []);

  const hideSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setActing(true);
    try {
      await Promise.all(
        Array.from(selected).map((fid) =>
          fetch(`/api/v1/faces/${fid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden: true }),
          })
        )
      );
      setSelected(new Set());
      await load();
    } finally {
      setActing(false);
    }
  }, [selected, load]);

  const detachSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setActing(true);
    try {
      await Promise.all(
        Array.from(selected).map((fid) =>
          fetch(`/api/v1/faces/${fid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ person_id: null }),
          })
        )
      );
      setSelected(new Set());
      await load();
    } finally {
      setActing(false);
    }
  }, [selected, load]);

  const splitSelected = useCallback(async () => {
    if (!person || selected.size === 0) return;
    setActing(true);
    try {
      const res = await fetch(`/api/v1/persons/${person.id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ face_ids: Array.from(selected) }),
      });
      if (res.ok) {
        setSelected(new Set());
        await load();
      }
    } finally {
      setActing(false);
    }
  }, [person, selected, load]);

  const openMerge = useCallback(async () => {
    setShowMerge(true);
    try {
      const res = await fetch("/api/v1/persons");
      if (res.ok) {
        const data = (await res.json()) as { persons: PersonGridEntry[] };
        setAllPersons((data.persons ?? []).filter((p) => p.id !== id));
      }
    } catch {
      // ignore
    }
  }, [id]);

  const doMerge = useCallback(
    async (targetId: string) => {
      if (!person) return;
      setActing(true);
      try {
        const res = await fetch(`/api/v1/persons/${person.id}/merge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ into: targetId }),
        });
        if (res.ok) {
          window.location.href = `/app/people/${targetId}`;
        }
      } finally {
        setActing(false);
        setShowMerge(false);
      }
    },
    [person]
  );

  const headline = useMemo(
    () => person?.name ?? "Unnamed person",
    [person]
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error || !person) {
    return (
      <div className="space-y-3">
        <Link
          href="/app/people"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          People
        </Link>
        <p className="text-sm text-red-500">{error ?? "Not found."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/app/people"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          People
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Unnamed person"
              className="rounded border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-foreground hover:border-border focus:border-border focus:outline-none"
              aria-label="Person name"
            />
            {savingName && <Loader2 className="h-4 w-4 animate-spin" />}
          </div>
          <p className="text-sm text-muted-foreground">
            {person.instanceCount} {person.instanceCount === 1 ? "face" : "faces"}
            {person.hidden && <span className="ml-2 italic">(hidden)</span>}{" "}
            — {headline}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={hideSelected}
          disabled={acting || selected.size === 0}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
        >
          <EyeOff className="h-4 w-4" />
          Hide ({selected.size})
        </button>
        <button
          type="button"
          onClick={detachSelected}
          disabled={acting || selected.size === 0}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
        >
          Detach ({selected.size})
        </button>
        <button
          type="button"
          onClick={splitSelected}
          disabled={acting || selected.size === 0}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
        >
          Split into new person
        </button>
        <button
          type="button"
          onClick={openMerge}
          disabled={acting}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
        >
          <Users className="h-4 w-4" />
          Merge into…
        </button>
      </div>

      {faces.length === 0 ? (
        <p className="text-sm text-muted-foreground">No faces attached.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9">
          {faces.map((f) => (
            <FaceCropBox
              key={f.id}
              face={f}
              selected={selected.has(f.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      {showMerge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Merge {headline} into…
              </h2>
              <button
                type="button"
                onClick={() => setShowMerge(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {allPersons.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No other people to merge into yet.
                </p>
              )}
              {allPersons.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => doMerge(p.id)}
                  disabled={acting}
                  className="block w-full rounded px-3 py-2 text-left text-sm text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                >
                  <span className="font-medium">
                    {p.name ?? "Unnamed person"}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({p.instanceCount})
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
