// SPDX-License-Identifier: MIT
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
import { Loader2, Users, Play, EyeOff, Settings, Pencil, Trash2 } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { ListErrorState } from "../_components/list-states";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";

interface PersonGroup {
  id: string;
  name: string;
  color: string;
  builtin: boolean;
}

interface PersonGridEntry {
  id: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
  coverAssetId: string | null;
  coverBbox: { x: number; y: number; w: number; h: number } | null;
  coverFaceCropKey: string | null;
  coverFaceCropUrl: string | null;
  groupIds: string[];
}

const PRESET_COLORS = [
  "#4f86c6", "#60c05c", "#e09b3d", "#c06060", "#9b6fc0", "#4ab8b8",
];

// Grid toast: a message plus an optional single action (e.g. Undo). Auto-
// dismissed by an effect so banners never persist across interactions.
interface GridToast {
  message: string;
  action?: { label: string; run: () => void };
}

function ManageGroupsDialog({
  groups,
  onRefresh,
}: {
  groups: PersonGroup[];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[4]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtinGroups = groups.filter((g) => g.builtin);
  const customGroups = groups.filter((g) => !g.builtin);

  const startEdit = (g: PersonGroup) => {
    setEditing(g.id);
    setEditName(g.name);
    setError(null);
  };

  const saveEdit = async (groupId: string) => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/person-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setEditing(null);
      onRefresh();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (groupId: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/person-groups/${groupId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      onRefresh();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const createGroup = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/person-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setNewName("");
      onRefresh();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <Settings className="h-3.5 w-3.5" />
        Manage groups
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container-high)] p-5 shadow-[var(--ft-elev-3)] outline-none">
          <Dialog.Title className="mb-4 text-sm font-semibold">Manage Groups</Dialog.Title>

          {error && <p className="mb-3 text-xs text-[var(--ft-color-error)]">{error}</p>}

          {builtinGroups.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {builtinGroups.map((g) => (
                <div key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                  <span className="flex-1 text-sm text-foreground">{g.name}</span>
                  <span className="text-xs text-muted-foreground">built-in</span>
                </div>
              ))}
            </div>
          )}

          {customGroups.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {customGroups.map((g) => (
                <div key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                  {editing === g.id ? (
                    <>
                      <input
                        className="flex-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit(g.id);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        autoFocus
                      />
                      <button type="button" disabled={saving || !editName.trim()} onClick={() => void saveEdit(g.id)} className="text-xs text-[var(--ft-color-primary-text)] hover:underline disabled:opacity-50">Save</button>
                      <button type="button" onClick={() => setEditing(null)} className="text-xs text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]">Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-[var(--ft-color-on-surface)]">{g.name}</span>
                      <button type="button" onClick={() => startEdit(g)} className="text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]" aria-label={`Rename ${g.name}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" disabled={saving} onClick={() => void deleteGroup(g.id)} className="text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-error)] disabled:opacity-50" aria-label={`Delete ${g.name}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-[var(--ft-color-outline-variant)] pt-4">
            <p className="mb-2 text-xs font-medium text-[var(--ft-color-on-surface-variant)]">Add custom group</p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`h-5 w-5 rounded-full transition-transform ${newColor === c ? "scale-125 ring-2 ring-offset-1 ring-[var(--ft-color-primary)]/40" : ""}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  placeholder="Group name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createGroup(); }}
                  className="flex-1 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--ft-color-primary)]"
                />
                <Button
                  type="button"
                  variant="tonal"
                  disabled={saving || !newName.trim()}
                  onClick={() => void createGroup()}
                >
                  Add
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Dialog.Close className="rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Phase 2 (faces/UX) — uniform circular face tile. Prefers the dedicated
// face-crop derivative (`coverFaceCropUrl`, served via the signed
// variant=face path) rendered object-cover in a circle. Until the crop is
// backfilled it falls back to the legacy preview + bbox CSS-zoom, then to a
// neutral placeholder so the tile is always a clean circle.
//
// Face/preview URL resolution is gated through a small concurrency limiter:
// a large people grid otherwise fires one fetch per card on mount, saturating
// the browser connection pool (net::ERR_INSUFFICIENT_RESOURCES, broken avatars).
let faceFetchActive = 0;
const faceFetchQueue: Array<() => void> = [];
async function limitedFetch(input: string): Promise<Response> {
  if (faceFetchActive >= 6) {
    await new Promise<void>((resolve) => faceFetchQueue.push(resolve));
  }
  faceFetchActive++;
  try {
    return await fetch(input);
  } finally {
    faceFetchActive--;
    faceFetchQueue.shift()?.();
  }
}

function FaceCrop({ entry }: { entry: PersonGridEntry }) {
  const [cropFailed, setCropFailed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // The persons payload now carries an absolute *signed* R2 URL for the cover
  // crop, so render it directly — no per-card resolve round-trip. Reset the
  // fail flag when the URL itself changes (e.g. a refetch re-signs the cover).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale fail flag when the signed URL changes
    setCropFailed(false);
  }, [entry.coverFaceCropUrl]);

  const showCrop = !!entry.coverFaceCropUrl && !cropFailed;

  // Fallback: only fetch the preview (for the legacy CSS-zoom) when there's no
  // signed crop URL, or that crop 403'd/expired.
  const needPreviewFallback = !showCrop && !!entry.coverAssetId;
  useEffect(() => {
    if (!needPreviewFallback || !entry.coverAssetId) return;
    let cancelled = false;
    limitedFetch(`/api/v1/assets/${entry.coverAssetId}/url?variant=preview`)
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
  if (showCrop) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={entry.coverFaceCropUrl!}
        alt={entry.name ?? "Unnamed person"}
        loading="lazy"
        decoding="async"
        onError={() => {
          // Signed URL expired / 403'd — fall through to the preview +
          // placeholder instead of the browser's broken-image glyph.
          setCropFailed(true);
        }}
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
  const [groups, setGroups] = useState<PersonGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clustering, setClustering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<GridToast | null>(null);
  // Tiles currently mid-ignore — disabled + dimmed until the PATCH resolves.
  const [ignoring, setIgnoring] = useState<Set<string>>(new Set());

  // Toast helper mirrors the detail page: set a banner, optionally with a
  // single action (e.g. Undo), and auto-dismiss it so it never lingers.
  const showToast = useCallback(
    (message: string, action?: GridToast["action"]) => {
      setToast({ message, action });
    },
    []
  );
  useEffect(() => {
    if (!toast) return;
    // Give action toasts (Undo) a longer window to react to.
    const ms = toast.action ? 8000 : 4000;
    const timer = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(timer);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [personsRes, groupsRes] = await Promise.all([
        fetch("/api/v1/persons"),
        fetch("/api/v1/person-groups"),
      ]);
      if (!personsRes.ok) {
        setError(`Failed to load people (${personsRes.status}).`);
        setPersons([]);
        return;
      }
      const data = (await personsRes.json()) as { persons: PersonGridEntry[] };
      setPersons(data.persons ?? []);
      if (groupsRes.ok) {
        const gdata = (await groupsRes.json()) as { groups: PersonGroup[] };
        setGroups(gdata.groups ?? []);
      }
    } catch {
      setError("Network error loading people.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Re-fetch when the page becomes visible again — covers the case
    // where the App Router cache served a stale snapshot after a person
    // was renamed on the detail page. visibilitychange + pageshow between
    // them cover tab-switch, in-app back-nav (Safari/iOS bfcache), and
    // browser focus.
    const handleVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const handlePageShow = () => void load();
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [load]);

  const runCluster = useCallback(async () => {
    setClustering(true);
    setToast(null);
    try {
      const res = await fetch("/api/v1/faces/cluster", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(`Clustering failed: ${body.error ?? res.status}`);
        return;
      }
      const data = (await res.json()) as {
        stats: { created: number; updated: number; noise: number };
      };
      showToast(
        `Clustered — ${data.stats.created} new, ${data.stats.updated} updated, ${data.stats.noise} noise.`
      );
      await load();
    } catch {
      showToast("Network error during clustering.");
    } finally {
      setClustering(false);
    }
  }, [load, showToast]);

  // Re-insert a person at (approximately) their original index, using a
  // functional update so concurrent list changes aren't clobbered by a stale
  // captured snapshot. No-op if they're already present.
  const reinsertPerson = useCallback(
    (person: PersonGridEntry, index: number) => {
      setPersons((prev) => {
        if (prev.some((p) => p.id === person.id)) return prev;
        const next = [...prev];
        next.splice(Math.min(Math.max(index, 0), next.length), 0, person);
        return next;
      });
    },
    []
  );

  // Undo an ignore: optimistically restore the tile, then un-hide server-side.
  const undoIgnore = useCallback(
    async (person: PersonGridEntry, index: number) => {
      setToast(null);
      reinsertPerson(person, index);
      try {
        const res = await fetch(`/api/v1/persons/${person.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hidden: false }),
        });
        if (!res.ok) {
          setPersons((prev) => prev.filter((p) => p.id !== person.id));
          showToast(`Couldn't restore person (${res.status}).`);
        }
      } catch {
        setPersons((prev) => prev.filter((p) => p.id !== person.id));
        showToast("Network error restoring person.");
      }
    },
    [reinsertPerson, showToast]
  );

  // #9 — ignore a person (junk cluster). Server cascades to its faces.
  // Optimistically drop the tile; restore only the failed person on error
  // (functional update, so a concurrent removal isn't undone), and offer Undo
  // on success since ignore is a destructive, one-tap action.
  const ignorePerson = useCallback(async (personId: string) => {
    const index = persons.findIndex((p) => p.id === personId);
    const removed = index >= 0 ? persons[index] : null;
    setIgnoring((prev) => new Set(prev).add(personId));
    setPersons((prev) => prev.filter((p) => p.id !== personId));
    try {
      const res = await fetch(`/api/v1/persons/${personId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      if (!res.ok) {
        if (removed) reinsertPerson(removed, index);
        showToast(`Couldn't ignore person (${res.status}).`);
      } else if (removed) {
        showToast(`Ignored ${removed.name ?? "person"}.`, {
          label: "Undo",
          run: () => void undoIgnore(removed, index),
        });
      }
    } catch {
      if (removed) reinsertPerson(removed, index);
      showToast("Network error ignoring person.");
    } finally {
      setIgnoring((prev) => {
        const next = new Set(prev);
        next.delete(personId);
        return next;
      });
    }
  }, [persons, reinsertPerson, undoIgnore, showToast]);

  // Groups that have at least one visible person — used to suppress empty chips.
  const activeGroupIds = useMemo(() => new Set(persons.flatMap((p) => p.groupIds)), [persons]);

  // Dead-end guard: the chip strip (incl. the "All" reset) only renders while
  // some group still has members. If the active group's last member is removed
  // (e.g. ignored), the strip vanishes while activeGroupId stays set, leaving
  // the grid stranded on an unclearable "No matches". Reset to "All" then.
  useEffect(() => {
    if (activeGroupId && !activeGroupIds.has(activeGroupId)) {
      setActiveGroupId(null);
    }
  }, [activeGroupId, activeGroupIds]);

  const visible = useMemo(() => {
    let list = persons;
    if (activeGroupId) {
      list = list.filter((p) => p.groupIds.includes(activeGroupId));
    }
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
      list = [...list].sort((a, b) => a.instanceCount - b.instanceCount);
    } else {
      list = [...list].sort((a, b) => b.instanceCount - a.instanceCount);
    }
    return list;
  }, [persons, activeGroupId, toolbar.filters.q, toolbar.filters.sort]);

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

      {/* Group filter chip strip — hidden while loading or when no groups have members */}
      {!loading && groups.some((g) => activeGroupIds.has(g.id)) && (
        <div className="px-4 overflow-x-auto">
          <div className="flex items-center gap-2 pb-1 min-w-0">
            <Chip
              variant="filter"
              selected={activeGroupId === null}
              onClick={() => setActiveGroupId(null)}
              className="shrink-0"
            >
              All
            </Chip>
            {groups
              .filter((g) => activeGroupIds.has(g.id))
              .map((g) => (
                <Chip
                  key={g.id}
                  variant="filter"
                  selected={activeGroupId === g.id}
                  onClick={() => setActiveGroupId(activeGroupId === g.id ? null : g.id)}
                  className="shrink-0"
                >
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: g.color }}
                  />
                  {g.name}
                </Chip>
              ))}
          </div>
        </div>
      )}

      <div className="px-4 space-y-4">
        <div className="flex items-center justify-between">
          <ManageGroupsDialog groups={groups} onRefresh={load} />
          <Link
            href="/app/people/ignored"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Ignored
          </Link>
        </div>

        {toast && (
          <div className="flex items-center justify-between gap-3 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] px-3 py-2 text-sm text-[var(--ft-color-on-surface)]">
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => toast.action?.run()}
                className="shrink-0 text-sm font-medium text-[var(--ft-color-primary-text)] hover:underline"
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}

        {loading && <PeopleSkeleton />}

        {error && !loading && (
          <ListErrorState message={error} onRetry={() => void load()} />
        )}

        {!loading && !error && persons.length === 0 && (
          <div className="rounded-[var(--ft-shape-medium)] border border-dashed border-[var(--ft-color-outline-variant)] p-8 text-center">
            <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
              No people yet. Upload photos with faces and click
              &ldquo;Run clustering&rdquo; to build cluster cards.
            </p>
          </div>
        )}

        {!loading && !error && persons.length > 0 && visible.length === 0 && (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">No matches.</p>
        )}

        {!loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {visible.map((p) => (
            <div key={p.id} className="group relative space-y-2">
              <Link
                href={`/app/people/${p.id}`}
                className={`block space-y-2 transition-opacity ${
                  ignoring.has(p.id) ? "pointer-events-none opacity-40" : ""
                }`}
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
              {/* #9 — hover overlay to ignore (hide) a junk cluster. Sits
                  outside the Link so the click doesn't navigate. */}
              {/* Reveal on hover/focus only. Hidden entirely on touch/coarse
                  pointers (no hover) — otherwise it stays invisible but
                  hit-testable over the card's top-right corner, so a tap there
                  silently ignores the person instead of opening them. Touch
                  users ignore from the detail page. */}
              <button
                type="button"
                onClick={() => void ignorePerson(p.id)}
                disabled={ignoring.has(p.id)}
                className="absolute right-1 top-1 hidden items-center gap-1 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-inverse-surface)]/80 px-2 py-1 text-[11px] font-medium text-[var(--ft-color-on-inverse-surface)] opacity-0 transition-opacity hover:bg-[var(--ft-color-inverse-surface)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-60 [@media(hover:hover)]:inline-flex"
                title="Ignore this person"
                aria-label={`Ignore ${p.name ?? "this person"}`}
              >
                <EyeOff className="h-3 w-3" />
                Ignore
              </button>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--ft-color-on-surface-variant)] py-4">Loading…</div>}>
      <PeopleContent />
    </Suspense>
  );
}
