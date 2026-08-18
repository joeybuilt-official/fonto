// SPDX-License-Identifier: MIT
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
import { ChevronLeft, Loader2, Check, EyeOff, Users, X, XCircle } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";

// Gate a fan-out of PATCHes so a large multi-select doesn't open hundreds of
// simultaneous connections (net::ERR_INSUFFICIENT_RESOURCES). Runs at most
// `limit` requests at once and preserves input order in the results.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

interface Person {
  id: string;
  workspaceId: string;
  name: string | null;
  coverFaceId: string | null;
  instanceCount: number;
  hidden: boolean;
  groupIds?: string[];
  // Intelligence Core — birth/death partial dates (split into date + precision
  // columns server-side). Anchor the date-inference engine.
  birthDate?: string | null;
  birthPrecision?: string | null;
  deathDate?: string | null;
  deathPrecision?: string | null;
}

const LIFE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Render the raw string a user would type back from the (date, precision) pair
// the server returns — so the editor inputs prefill with "2014", "2014-08", or
// "2014-08-11" rather than a normalised full date.
function partialToInput(
  date: string | null | undefined,
  precision: string | null | undefined
): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  if (precision === "day") return `${y}-${m}-${d}`;
  if (precision === "month") return `${y}-${m}`;
  return y ?? "";
}

// Friendly display label (day → "Aug 11, 2014", month → "Aug 2014", year →
// "2014") for the read-only summary next to the editor.
function partialToLabel(
  date: string | null | undefined,
  precision: string | null | undefined
): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-");
  if (precision === "day" && y && m && d) {
    return `${LIFE_MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
  }
  if (precision === "month" && y && m) {
    return `${LIFE_MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  return y ?? date;
}

interface PersonGroup {
  id: string;
  name: string;
  color: string;
  builtin: boolean;
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
  // Phase 2 (faces/UX) — prefer the sharp dedicated crop. faceCropUrl is now an
  // absolute *signed* R2 URL, so use it directly (no resolve round-trip); the
  // preview fallback still resolves (previewUrl stays a relative API path).
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const showCrop = !!face.faceCropUrl;
  const needPreviewFallback = !showCrop;
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
  if (showCrop) {
    // Sharp dedicated crop — render object-cover (background-size cover) so the
    // square already-centered face fills the tile.
    style = {
      backgroundImage: `url(${face.faceCropUrl})`,
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
  // Intelligence Core — birth/death editor. Holds the raw partial-date strings.
  const [birth, setBirth] = useState("");
  const [death, setDeath] = useState("");
  const [savingLife, setSavingLife] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);

  // Transient toasts — reuses the floating success/error pattern from
  // uploads-section (no shared toast lib in this app). Used for the #8
  // auto-tag propagation feedback after a merge.
  const [toasts, setToasts] = useState<
    { id: string; message: string; type: "success" | "error" }[]
  >([]);
  const showToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      const tid = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id: tid, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== tid));
      }, 4000);
    },
    []
  );

  // Groups
  const [allGroups, setAllGroups] = useState<PersonGroup[]>([]);
  const [personGroupIds, setPersonGroupIds] = useState<string[]>([]);
  const [savingGroups, setSavingGroups] = useState(false);

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
      const [pRes, fRes, gRes] = await Promise.all([
        fetch(`/api/v1/persons/${id}`),
        fetch(`/api/v1/persons/${id}/faces?limit=200`),
        fetch("/api/v1/person-groups"),
      ]);
      if (!pRes.ok) {
        setError(`Failed to load person (${pRes.status}).`);
        return;
      }
      const pData = (await pRes.json()) as { person: Person };
      setPerson(pData.person);
      setName(pData.person.name ?? "");
      setBirth(partialToInput(pData.person.birthDate, pData.person.birthPrecision));
      setDeath(partialToInput(pData.person.deathDate, pData.person.deathPrecision));
      setPersonGroupIds(pData.person.groupIds ?? []);
      if (fRes.ok) {
        const fData = (await fRes.json()) as { faces: FaceEntry[] };
        setFaces(fData.faces ?? []);
      }
      if (gRes.ok) {
        const gData = (await gRes.json()) as { groups: PersonGroup[] };
        setAllGroups(gData.groups ?? []);
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

  // #8 — surface a propagation toast handed off via sessionStorage by the
  // merge on the *source* person page (we navigate here after a merge).
  useEffect(() => {
    let stashed: string | null = null;
    try {
      stashed = sessionStorage.getItem("fonto.faceTagToast");
      if (stashed) sessionStorage.removeItem("fonto.faceTagToast");
    } catch {
      /* sessionStorage unavailable */
    }
    if (stashed) showToast(stashed, "success");
  }, [showToast]);

  const toggleGroup = useCallback(
    async (groupId: string) => {
      if (!person) return;
      const next = personGroupIds.includes(groupId)
        ? personGroupIds.filter((g) => g !== groupId)
        : [...personGroupIds, groupId];
      setPersonGroupIds(next);
      setSavingGroups(true);
      try {
        const res = await fetch(`/api/v1/persons/${person.id}/groups`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupIds: next }),
        });
        if (!res.ok) {
          setPersonGroupIds(personGroupIds); // revert — non-OK resolves normally
          showToast("Couldn't update groups.", "error");
        }
      } catch {
        setPersonGroupIds(personGroupIds); // revert on error
        showToast("Couldn't update groups.", "error");
      } finally {
        setSavingGroups(false);
      }
    },
    [person, personGroupIds, showToast]
  );

  const saveName = useCallback(async () => {
    if (!person) return;
    const trimmed = name.trim();
    // Skip the PATCH when nothing changed — onBlur fires on every focus-out
    // (including the blur triggered by clicking "Remove name"), which would
    // otherwise race an unchanged rename against the removal.
    if (trimmed === (person.name ?? "")) return;
    setSavingName(true);
    try {
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
        // Non-OK is surfaced as a toast (not setError) so a transient failure
        // doesn't collapse the whole detail page to a bare error view.
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        showToast(
          `Rename failed (${res.status}): ${body?.error ?? "unknown error"}`,
          "error"
        );
        setName(person.name ?? "");
      }
    } catch (err) {
      showToast(
        `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
      setName(person.name ?? "");
    } finally {
      setSavingName(false);
    }
  }, [person, name, router, showToast]);

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
        showToast(
          `Remove-name failed (${res.status}): ${body?.error ?? "unknown error"}`,
          "error"
        );
      }
    } catch (err) {
      showToast(
        `Remove-name failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setSavingName(false);
    }
  }, [person, router, showToast]);

  // Intelligence Core — save birth/death partial dates. Sends the raw strings
  // (or null to clear); the server splits them into date + precision columns.
  const saveLife = useCallback(async () => {
    if (!person) return;
    setSavingLife(true);
    try {
      const res = await fetch(`/api/v1/persons/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          birth: birth.trim() === "" ? null : birth.trim(),
          death: death.trim() === "" ? null : death.trim(),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { person: Person };
        setPerson(data.person);
        setBirth(partialToInput(data.person.birthDate, data.person.birthPrecision));
        setDeath(partialToInput(data.person.deathDate, data.person.deathPrecision));
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        showToast(
          `Save dates failed (${res.status}): ${body?.error ?? "unknown error"}`,
          "error"
        );
      }
    } catch (err) {
      showToast(
        `Save dates failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setSavingLife(false);
    }
  }, [person, birth, death, showToast]);

  // #9 — ignore the whole person (junk cluster). Server cascades to its
  // faces. On success, navigate back to the grid (the tile is now hidden).
  const ignorePerson = useCallback(async () => {
    if (!person) return;
    setActing(true);
    try {
      const res = await fetch(`/api/v1/persons/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      if (res.ok) {
        router.push("/app/people");
        router.refresh();
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        showToast(
          `Ignore failed (${res.status}): ${body?.error ?? "unknown error"}`,
          "error"
        );
      }
    } catch (err) {
      showToast(
        `Ignore failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setActing(false);
    }
  }, [person, router, showToast]);

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
      const results = await mapWithConcurrency(
        Array.from(selected),
        6,
        (fid) =>
          fetch(`/api/v1/faces/${fid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden: true }),
          })
      );
      // Reconcile regardless of partial failure — some faces are already
      // hidden server-side, so reload so the grid reflects what changed.
      setSelected(new Set());
      await load();
      if (results.some((r) => !r.ok)) {
        showToast("Couldn't hide some faces. Try again.", "error");
      }
    } catch {
      showToast("Couldn't hide faces. Check your connection.", "error");
    } finally {
      setActing(false);
    }
  }, [selected, load, showToast]);

  const detachSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setActing(true);
    try {
      const results = await mapWithConcurrency(
        Array.from(selected),
        6,
        (fid) =>
          fetch(`/api/v1/faces/${fid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ person_id: null }),
          })
      );
      // Reconcile regardless of partial failure — some faces are already
      // detached server-side, so reload so the grid reflects what changed.
      setSelected(new Set());
      await load();
      if (results.some((r) => !r.ok)) {
        showToast("Couldn't detach some faces. Try again.", "error");
      }
    } catch {
      showToast("Couldn't detach faces. Check your connection.", "error");
    } finally {
      setActing(false);
    }
  }, [selected, load, showToast]);

  const splitSelected = useCallback(async () => {
    if (!person || selected.size === 0) return;
    const count = selected.size;
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
        showToast(
          `Split ${count} ${count === 1 ? "face" : "faces"} into a new person.`,
          "success"
        );
      } else {
        // A non-OK split (409/500) previously produced no feedback and left
        // the selection intact, so the user retried blindly.
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        showToast(
          `Couldn't split faces${body?.error ? `: ${body.error}` : ". Try again."}`,
          "error"
        );
      }
    } catch {
      showToast("Couldn't split faces. Check your connection.", "error");
    } finally {
      setActing(false);
    }
  }, [person, selected, load, showToast]);

  // Opening only fetches the ranked candidates; the flat "All people" list is
  // loaded server-side (limit + name-filter) by the debounced effect below, so
  // a large workspace never pulls the whole persons table into the picker.
  const openMerge = useCallback(async () => {
    setShowMerge(true);
    setMergeQuery("");
    setCandidatesLoading(true);
    try {
      const candidatesRes = await fetch(
        `/api/v1/persons/${id}/merge-candidates`
      );
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

  // Merge-picker "All people" list. Loaded from the persons endpoint with a
  // server-side `limit` + name `q` (which excludes unnamed clusters), so typing
  // surfaces matches beyond the first page instead of client-filtering a giant
  // pre-loaded list. Empty query loads immediately; typing is debounced.
  useEffect(() => {
    if (!showMerge) return;
    const q = mergeQuery.trim();
    let cancelled = false;
    const t = setTimeout(
      () => {
        const sp = new URLSearchParams();
        sp.set("limit", "500");
        if (q) sp.set("q", q);
        fetch(`/api/v1/persons?${sp.toString()}`)
          .then((r) => (r.ok ? r.json() : { persons: [] }))
          .then((data: { persons?: PersonGridEntry[] }) => {
            if (!cancelled) {
              setAllPersons((data.persons ?? []).filter((p) => p.id !== id));
            }
          })
          .catch(() => undefined);
      },
      q ? 250 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [showMerge, mergeQuery, id]);

  const doMerge = useCallback(
    async (targetId: string, targetName?: string | null) => {
      if (!person) return;
      setActing(true);
      try {
        const res = await fetch(`/api/v1/persons/${person.id}/merge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ into: targetId }),
        });
        if (!res.ok) {
          showToast("Merge failed. Try again.", "error");
          return;
        }
        {
          // #8 — auto-tag propagation feedback. The merge response now
          // carries { propagated: { assigned, suggested } | null }. Stash a
          // message in sessionStorage so the *target* person page (where we
          // land) can surface it after navigation; the count is meaningless
          // on a page we're about to leave.
          const data = (await res.json().catch(() => null)) as {
            propagated?: { assigned: number; suggested: number } | null;
          } | null;
          const prop = data?.propagated;
          if (prop && (prop.assigned > 0 || prop.suggested > 0)) {
            const who = targetName?.trim() || "this person";
            const parts: string[] = [];
            if (prop.assigned > 0) {
              parts.push(`Added ${prop.assigned} more photo${prop.assigned === 1 ? "" : "s"} of ${who}.`);
            }
            if (prop.suggested > 0) {
              parts.push(`${prop.suggested} more to review.`);
            }
            try {
              sessionStorage.setItem("fonto.faceTagToast", parts.join(" "));
            } catch {
              /* sessionStorage unavailable — silently skip the toast */
            }
          }
          window.location.href = `/app/people/${targetId}`;
        }
      } catch {
        showToast("Merge failed. Check your connection.", "error");
      } finally {
        setActing(false);
        setShowMerge(false);
      }
    },
    [person, showToast]
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
      <h1 className="sr-only">{headline}</h1>
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
          {/* Group assignment chips */}
          {allGroups.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {allGroups.map((g) => {
                const active = personGroupIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    disabled={savingGroups}
                    onClick={() => void toggleGroup(g.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                      active
                        ? "border-transparent text-white"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                    style={active ? { backgroundColor: g.color } : undefined}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: g.color }}
                    />
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Intelligence Core — Born / Died editor. Partial dates anchor the
          date-inference engine; the server splits the raw string into
          date + precision columns. */}
      <div className="rounded-lg border border-border bg-background p-4 space-y-3 max-w-md">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Born / Died</h2>
          {(() => {
            const b = partialToLabel(person.birthDate, person.birthPrecision);
            const d = partialToLabel(person.deathDate, person.deathPrecision);
            if (!b && !d) return null;
            return (
              <p className="text-xs text-muted-foreground">
                {b ? `Born ${b}` : ""}
                {b && d ? " · " : ""}
                {d ? `Died ${d}` : ""}
              </p>
            );
          })()}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground uppercase">
              Born
            </span>
            <input
              type="text"
              value={birth}
              onChange={(e) => setBirth(e.target.value)}
              placeholder="YYYY or YYYY-MM or YYYY-MM-DD"
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              aria-label="Birth date"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground uppercase">
              Died
            </span>
            <input
              type="text"
              value={death}
              onChange={(e) => setDeath(e.target.value)}
              placeholder="YYYY or YYYY-MM or YYYY-MM-DD"
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              aria-label="Death date"
            />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void saveLife()}
            disabled={savingLife}
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sidebar-accent disabled:opacity-60"
          >
            {savingLife ? "Saving…" : "Save dates"}
          </button>
          {savingLife && <Loader2 className="h-4 w-4 animate-spin" />}
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
        {/* #9 — ignore this whole person (junk cluster). Cascades to its
            faces server-side; navigates back to the grid on success. */}
        <button
          type="button"
          onClick={() => void ignorePerson()}
          disabled={acting}
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-60"
        >
          <EyeOff className="h-4 w-4" />
          Ignore this person
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

      {/* base-ui Dialog — provides focus trap, Escape-to-close and
          backdrop-dismiss (parity with ManageGroupsDialog on the grid). */}
      <Dialog.Root open={showMerge} onOpenChange={setShowMerge}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg outline-none">
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold text-foreground">
                Merge {headline} into…
              </Dialog.Title>
              <Dialog.Close className="text-sm text-muted-foreground hover:text-foreground">
                Cancel
              </Dialog.Close>
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
                        onClick={() => doMerge(c.id, c.name)}
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
                      onClick={() => doMerge(p.id, p.name)}
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
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* #8 — floating propagation toasts (success/error). Mirrors the
          uploads-section ToastContainer styling. */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg pointer-events-auto ${
                t.type === "success"
                  ? "border-green-500/30 bg-card text-foreground"
                  : "border-destructive/30 bg-card text-destructive"
              }`}
            >
              {t.type === "success" ? (
                <Check className="h-4 w-4 text-green-500 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive shrink-0" />
              )}
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
