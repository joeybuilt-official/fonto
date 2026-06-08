// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — Stacks sub-tab inside /app/collections.
//
// Lifted verbatim from the pre-Phase-2 `app/(app)/app/stacks/page.tsx`
// StacksContent body. Inner "stacks / suggestions" tab strip stays —
// the outer Collections fan-out doesn't replace this nested split.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Layers, Loader2, Check, X } from "lucide-react";
import { AssetPageToolbar } from "../../_components/asset-page-toolbar";
import { ListErrorState } from "../../_components/list-states";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";
import { cn } from "@/lib/utils";

interface StackRow {
  id: string;
  name: string | null;
  primaryAssetId: string;
  primaryFilename: string | null;
  primaryMimeType: string | null;
  primaryCapturedAt: string | null;
  memberCount: number;
  createdAt: string;
}

interface Suggestion {
  assetIds: string[];
  reason: "raw+jpeg" | "burst";
}

type InnerTab = "stacks" | "suggestions";

function StackTile({
  thumbUrl,
  filename,
  count,
  name,
  active,
  onClick,
}: {
  thumbUrl: string | null;
  filename: string | null;
  count: number;
  name: string | null;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:bg-muted/40",
        active && "ring-2 ring-primary"
      )}
    >
      <div className="aspect-square bg-muted/30 relative">
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl}
            alt={name ?? filename ?? "Stack"}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          </div>
        )}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          <Layers className="h-3 w-3" />
          {count}
        </div>
      </div>
      <div className="px-2 py-1.5">
        <p className="truncate text-xs font-medium text-foreground">
          {name ?? filename ?? "Untitled"}
        </p>
      </div>
    </button>
  );
}

function SuggestionRow({
  s,
  thumbUrls,
  onAccept,
  onDismiss,
  busy,
}: {
  s: Suggestion;
  thumbUrls: Record<string, string>;
  onAccept: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap gap-1.5">
        {s.assetIds.slice(0, 8).map((id) => (
          <div
            key={id}
            className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted/30"
          >
            {thumbUrls[id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbUrls[id]}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <ImageIcon className="h-4 w-4 m-auto mt-3 text-muted-foreground" />
            )}
          </div>
        ))}
        {s.assetIds.length > 8 && (
          <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
            +{s.assetIds.length - 8}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {s.reason === "raw+jpeg" ? "RAW + JPEG pair" : "Burst"}
        </p>
        <p className="text-xs text-muted-foreground">
          {s.assetIds.length} {s.assetIds.length === 1 ? "asset" : "assets"}
        </p>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onDismiss}
          disabled={busy}
          className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Dismiss
        </button>
        <button
          onClick={onAccept}
          disabled={busy}
          className="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Accept
        </button>
      </div>
    </div>
  );
}

export function StacksTab() {
  const router = useRouter();
  const toolbar = useToolbarState({
    page: "stacks",
    availableFilters: [],
  });

  const [tab, setTab] = useState<InnerTab>("stacks");
  const [stacks, setStacks] = useState<StackRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [suggestionThumbs, setSuggestionThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function suggestionKey(s: Suggestion): string {
    return [...s.assetIds].sort().join(",");
  }

  const loadStacks = useCallback(async () => {
    const r = await fetch("/api/v1/stacks");
    if (!r.ok) throw new Error(`stacks ${r.status}`);
    const d = (await r.json()) as { stacks?: StackRow[] };
    const list = d.stacks ?? [];
    setStacks(list);
    if (list.length === 0) {
      setCoverUrls({});
      return;
    }
    const urlRes = await fetch("/api/v1/assets/urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: list.map((s) => s.primaryAssetId),
        variant: "thumb",
      }),
    });
    const urlData = (await urlRes.json()) as { urls?: Record<string, string> };
    setCoverUrls(urlData.urls ?? {});
  }, []);

  const loadSuggestions = useCallback(async () => {
    const r = await fetch("/api/v1/stacks/suggestions");
    if (!r.ok) throw new Error(`stacks-suggestions ${r.status}`);
    const d = (await r.json()) as { suggestions?: Suggestion[] };
    const list = d.suggestions ?? [];
    setSuggestions(list);
    const allIds = Array.from(new Set(list.flatMap((s) => s.assetIds))).slice(0, 500);
    if (allIds.length === 0) {
      setSuggestionThumbs({});
      return;
    }
    const urlRes = await fetch("/api/v1/assets/urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: allIds, variant: "thumb" }),
    });
    const urlData = (await urlRes.json()) as { urls?: Record<string, string> };
    setSuggestionThumbs(urlData.urls ?? {});
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      await Promise.all([loadStacks(), loadSuggestions()]);
    } catch {
      setError(true);
      setStacks([]);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [loadStacks, loadSuggestions]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function acceptSuggestion(s: Suggestion) {
    const key = suggestionKey(s);
    setAccepting(key);
    try {
      const r = await fetch("/api/v1/stacks/suggestions/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds: s.assetIds }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setToast(`Couldn't create stack: ${body.error ?? r.status}`);
        return;
      }
      setToast(`Stacked ${s.assetIds.length} asset${s.assetIds.length === 1 ? "" : "s"}.`);
      await Promise.all([loadStacks(), loadSuggestions()]);
    } catch {
      setToast("Network error.");
    } finally {
      setAccepting(null);
    }
  }

  function dismissSuggestion(s: Suggestion) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(suggestionKey(s));
      return next;
    });
  }

  const visibleSuggestions = useMemo(
    () => suggestions.filter((s) => !dismissed.has(suggestionKey(s))),
    [suggestions, dismissed]
  );

  const visibleStacks = useMemo(() => {
    let list = stacks;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter(
        (s) =>
          (s.name?.toLowerCase().includes(needle) ?? false) ||
          (s.primaryFilename?.toLowerCase().includes(needle) ?? false)
      );
    }
    if (toolbar.filters.sort === "oldest") {
      list = [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } else if (toolbar.filters.sort === "name") {
      list = [...list].sort((a, b) =>
        (a.name ?? a.primaryFilename ?? "").localeCompare(
          b.name ?? b.primaryFilename ?? ""
        )
      );
    }
    return list;
  }, [stacks, toolbar.filters.q, toolbar.filters.sort]);

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Stacks"
        count={
          loading
            ? undefined
            : tab === "stacks"
            ? visibleStacks.length
            : visibleSuggestions.length
        }
        toolbar={toolbar}
        searchPlaceholder={
          tab === "stacks" ? "Search stacks…" : "Search suggestions…"
        }
        sortOptions={tab === "stacks" ? ["newest", "oldest", "name"] : []}
        showDensity={false}
        showSelect={false}
      />

      <div className="px-4 space-y-4">
        <div className="flex gap-1 border-b border-border">
          {(["stacks", "suggestions"] as InnerTab[]).map((t) => {
            const active = tab === t;
            const badge = t === "suggestions" ? visibleSuggestions.length : null;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "stacks" ? "Stacks" : "Suggestions"}
                {badge != null && badge > 0 && (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {toast && (
          <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            {toast}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <ListErrorState
            message="Couldn't load stacks. Check your connection and retry."
            onRetry={() => void loadAll()}
          />
        ) : tab === "stacks" ? (
          visibleStacks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Layers className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                No stacks yet. Check the Suggestions tab to confirm groups
                detected from EXIF (RAW+JPEG pairs, bursts).
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {visibleStacks.map((s) => (
                <StackTile
                  key={s.id}
                  thumbUrl={coverUrls[s.primaryAssetId] ?? null}
                  filename={s.primaryFilename}
                  count={s.memberCount}
                  name={s.name}
                  onClick={() => router.push(`/app/stacks/${s.id}`)}
                />
              ))}
            </div>
          )
        ) : visibleSuggestions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <Layers className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              No suggestions right now. The suggester runs on every page load
              and looks for RAW+JPEG pairs or bursts (3+ frames within 5s
              from the same camera).
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleSuggestions.map((s) => (
              <SuggestionRow
                key={suggestionKey(s)}
                s={s}
                thumbUrls={suggestionThumbs}
                onAccept={() => acceptSuggestion(s)}
                onDismiss={() => dismissSuggestion(s)}
                busy={accepting === suggestionKey(s)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
