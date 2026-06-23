// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0010 — user-facing duplicates review. Lists candidate near-duplicate
// groups; per group the user can "Keep best, trash rest" (reversible
// consolidation with a grace window) or "Not duplicates" (dismiss). Heavy SSIM
// scoring stays in the owner-only Tidy Up admin lane — this surface shows the
// stored grouping + thumbnails so it stays fast.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, X, ImageIcon } from "lucide-react";
import { type Asset } from "../_components/photo-card";
import { ListErrorState } from "../_components/list-states";

interface DupGroup {
  groupId: string;
  confidence: number | null;
  members: Asset[];
}

function MemberThumb({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.mimeType.startsWith("image/")) return;
    let cancelled = false;
    fetch(`/api/v1/assets/${asset.id}/url?variant=thumb`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => {
        if (!cancelled) setUrl(d?.url ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.mimeType]);

  return (
    <div
      className="relative h-24 w-24 shrink-0 overflow-hidden rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container)]"
      title={asset.filename}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={asset.filename} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ImageIcon className="h-5 w-5 text-[var(--ft-color-on-surface-variant)]" />
        </div>
      )}
    </div>
  );
}

export default function DuplicatesPage() {
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/v1/duplicates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { groups: DupGroup[] };
      setGroups(data.groups ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(groupId: string, action: "resolve" | "dismiss") {
    setBusy((b) => ({ ...b, [groupId]: true }));
    try {
      const res = await fetch(`/api/v1/duplicates/${groupId}/${action}`, {
        method: "POST",
      });
      if (res.ok) {
        // Drop the group from view — resolve trashed the dupes (reversible),
        // dismiss marked it reviewed; either way it leaves the queue.
        setGroups((gs) => gs.filter((g) => g.groupId !== groupId));
      }
    } finally {
      setBusy((b) => ({ ...b, [groupId]: false }));
    }
  }

  return (
    <div className="space-y-4 px-4 py-3">
      <div className="flex items-center gap-2">
        <Copy className="h-5 w-5 text-[var(--ft-color-primary)]" />
        <h1 className="font-heading text-lg font-semibold text-[var(--ft-color-on-surface)]">
          Duplicates
        </h1>
        {!loading && groups.length > 0 && (
          <span className="text-sm text-[var(--ft-color-on-surface-variant)]">
            {groups.length} {groups.length === 1 ? "group" : "groups"}
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
          Finding duplicates…
        </p>
      )}

      {error && !loading && <ListErrorState message="Couldn't load duplicates." onRetry={load} />}

      {!loading && !error && groups.length === 0 && (
        <div className="rounded-[var(--ft-shape-medium)] border border-dashed border-[var(--ft-color-outline-variant)] p-8 text-center">
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
            No duplicate groups to review. Nice and tidy.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <div
          key={g.groupId}
          className="rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] p-3 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--ft-color-on-surface)]">
              {g.members.length} similar items
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => act(g.groupId, "resolve")}
                disabled={busy[g.groupId]}
                className="flex items-center gap-1 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] px-3 py-1 text-xs font-medium text-[var(--ft-color-on-primary)] disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" /> Keep best, trash rest
              </button>
              <button
                onClick={() => act(g.groupId, "dismiss")}
                disabled={busy[g.groupId]}
                className="flex items-center gap-1 rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] px-3 py-1 text-xs font-medium text-[var(--ft-color-on-surface)] disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> Not duplicates
              </button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {g.members.map((m) => (
              <MemberThumb key={m.id} asset={m} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
