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
import { useRouter } from "next/navigation";
import { ChevronLeft, Loader2, Check, EyeOff, Users, X } from "lucide-react";

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
  // Phase 2 (faces/UX) — dedicated square crop URL (signed variant=face path).
  // NULL until backfilled; falls back to the legacy preview CSS-zoom.
  faceCropKey?: string | null;
  faceCropUrl?: string | null;
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
  // Phase 2 (faces/UX) — prefer the sharp dedicated crop. Resolve the signed
  // face-crop URL when present; otherwise fall back to the preview CSS-zoom.
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const [cropFailed, setCropFailed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setCropUrl(null);
    setCropFailed(false);
    if (!face.faceCropUrl) return;
    let cancelled = false;
    fetch(face.faceCropUrl)
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
  }, [face.faceCropUrl]);

  const needPreviewFallback = !face.faceCropUrl || cropFailed;
  useEffect(() => {
    if (!needPreviewFallback) return;
    let cancelled = false;
    fetch(face.asset.previewUrl)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setPreviewUrl(d.url ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needPreviewFallback, face.asset.previewUrl]);

  let style: React.CSSProperties = {};
  if (cropUrl) {
    // Sharp dedicated crop — render object-cover (background-size cover) so the
    // square already-centered face fills the tile.
    style = {
      backgroundImage: `url(${cropUrl})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  } else if (previewUrl && face.bbox) {
    const { x, y, w, h } = face.bbox;
    const scale = 1 / Math.max(w, h);
    style = {
      backgroundImage: `url(${previewUrl})`,
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
  const router = useRouter();

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
  // Ranked likely-duplicate candidates from the embedding similarity API;
  // surfaced above the flat list in the picker.
  const [mergeCandidates, setMergeCandidates] = useState<
    { id: string; name: string; instanceCount: number; distance: number }[]
  >([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // Type-to-filter input for the merge picker. Bound to the search box at
  // the top of the modal — matches case-insensitive substring on `name`.
  const [mergeQuery, setMergeQuery] = useState("");

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
        // Invalidate the App Router cache so /app/people fetches fresh
        // persons on the next navigation — otherwise the grid showed
        // the pre-rename "Unnamed" label until a hard reload.
        router.refresh();
      } else {
        // Non-OK was silently swallowed before — names "didn't save" with
        // no signal. Surface the error so the user can act on it (re-auth,
        // refresh, file a bug, etc).
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          `Rename failed (${res.status}): ${body?.error ?? "unknown error"}`
        );
        setName(person.name ?? "");
      }
    } catch (err) {
      setError(
        `Rename failed: ${err instanceof Error ? err.message : String(err)}`
      );
      setName(person.name ?? "");
    } finally {
      setSavingName(false);
    }
  }, [person, name, router]);

  // Phase 2 (faces/UX) — explicit Remove-name control. The PATCH route clears
  // the name on null, so we send `name: null` and optimistically reflect the
  // cleared state. Distinct from blurring an empty input so it's discoverable.
  const removeName = useCallback(async () => {
    if (!person) return;
    setSavingName(true);
    try {
      const res = await fetch(`/api/v1/persons/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: null }),
      });
      if (res.ok) {
        const data = (await res.json()) as { person: Person };
        setPerson(data.person);
        setName(data.person.name ?? "");
        router.refresh();
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          `Remove-name failed (${res.status}): ${body?.error ?? "unknown error"}`
        );
      }
    } catch (err) {
      setError(
        `Remove-name failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSavingName(false);
    }
  }, [person, router]);

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
    setMergeQuery("");
    setCandidatesLoading(true);
    try {
      const [personsRes, candidatesRes] = await Promise.all([
        fetch("/api/v1/persons"),
        fetch(`/api/v1/persons/${id}/merge-candidates`),
      ]);
      if (personsRes.ok) {
        const data = (await personsRes.json()) as { persons: PersonGridEntry[] };
        setAllPersons((data.persons ?? []).filter((p) => p.id !== id));
      }
      if (candidatesRes.ok) {
        const data = (await candidatesRes.json()) as {
          candidates: { id: string; name: string; instanceCount: number; distance: number }[];
        };
        setMergeCandidates(data.candidates ?? []);
      }
    } catch {
      // ignore — picker still works on the flat list
    } finally {
      setCandidatesLoading(false);
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
    // Phase 2 (faces/UX) — skeleton instead of a bare "Loading…" line.
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="h-4 w-16 animate-pulse rounded bg-muted/40" />
          <div className="h-9 w-56 animate-pulse rounded bg-muted/40" />
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9">
          {Array.from({ length: 18 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square animate-pulse rounded-lg bg-muted/40"
            />
          ))}
        </div>
      </div>
    );
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
              placeholder="Add a name…"
              title="Click to rename — type a name and press Enter"
              className="rounded border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-foreground hover:border-border focus:border-border focus:outline-none"
              aria-label="Person name (click to rename)"
            />
            {savingName && <Loader2 className="h-4 w-4 animate-spin" />}
            {/* Phase 2 (faces/UX) — explicit Remove-name control, shown only
                when the person currently has a name. */}
            {person.name && !savingName && (
              <button
                type="button"
                onClick={removeName}
                className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                aria-label="Remove name"
              >
                <X className="h-3.5 w-3.5" />
                Remove name
              </button>
            )}
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
            <input
              type="text"
              value={mergeQuery}
              onChange={(e) => setMergeQuery(e.target.value)}
              autoFocus
              placeholder="Type a name…"
              aria-label="Filter people by name"
              className="mb-3 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {allPersons.length === 0 && !candidatesLoading && (
                <p className="text-sm text-muted-foreground">
                  No other people to merge into yet.
                </p>
              )}

              {/* Likely-duplicate candidates ranked by embedding similarity —
                  same scoring band as face-match suggestions. Distance ≤ 0.26
                  is auto-assign-grade; 0.32 is the manual-review threshold.
                  Below 0.55 = noise, filtered by the API. */}
              {(() => {
                const q = mergeQuery.trim().toLowerCase();
                // Unnamed clusters are dropped — Merge Into is a named-person
                // operation. If you've got an unnamed face you want to attach
                // to someone, use the per-face tagging sheet.
                const filteredCandidates = mergeCandidates.filter((c) =>
                  c.name && (q === "" || c.name.toLowerCase().includes(q))
                );
                const filteredRest = allPersons
                  .filter((p) => p.name)
                  .filter((p) => !mergeCandidates.some((c) => c.id === p.id))
                  .filter((p) => q === "" || p.name!.toLowerCase().includes(q));
                if (
                  filteredCandidates.length === 0 &&
                  filteredRest.length === 0 &&
                  !candidatesLoading
                ) {
                  return (
                    <p className="text-sm text-muted-foreground">
                      {q
                        ? `No named people match "${mergeQuery}".`
                        : "No named people to merge into yet."}
                    </p>
                  );
                }
                return (
                  <>
                  {filteredCandidates.length > 0 && (
                    <>
                      <p className="px-1 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Likely matches
                      </p>
                      {filteredCandidates.map((c) => {
                    const tier =
                      c.distance <= 0.26
                        ? { label: "Very likely", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" }
                        : c.distance <= 0.32
                        ? { label: "Likely",       cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" }
                        : c.distance <= 0.45
                        ? { label: "Possible",     cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" }
                        : { label: "Maybe",        cls: "bg-muted text-muted-foreground" };
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => doMerge(c.id)}
                        disabled={acting}
                        className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{c.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({c.instanceCount})
                          </span>
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tier.cls}`}>
                          {tier.label}
                        </span>
                      </button>
                    );
                      })}
                      {filteredRest.length > 0 && (
                        <>
                          <div className="my-2 border-t border-border" />
                          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            All people
                          </p>
                        </>
                      )}
                    </>
                  )}

                  {filteredRest.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => doMerge(p.id)}
                      disabled={acting}
                      className="block w-full rounded px-3 py-2 text-left text-sm text-foreground hover:bg-sidebar-accent disabled:opacity-60"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({p.instanceCount})
                      </span>
                    </button>
                  ))}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
