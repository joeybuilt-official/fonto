// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — Activity section of the Updates surface.
//
// Lifts the body of the legacy `/app/activity` page (cursor-paginated
// workspace activity feed) into a section component that drops its
// own page chrome. Network endpoint + state shape are unchanged.
// The old route still mounts this same component via a deprecation
// banner wrapper (Phase 5 → middleware redirect).

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

/** Stable hue from the actor id so distinct actors read apart at a glance. */
function actorHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0x7fffffff;
  return h % 360;
}

function ActorAvatar({
  actorUserId,
  actorUserName,
}: {
  actorUserId: string | null;
  actorUserName?: string | null;
}) {
  if (!actorUserId) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs">
        ?
      </span>
    );
  }
  // Initials from the display name when we have it; fall back to the id so a
  // never-resolved actor still renders something stable.
  const initialsSource = actorUserName?.trim() || actorUserId;
  const initials = initialsSource.slice(0, 2).toUpperCase();
  const hue = actorHue(actorUserId);
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue} 50% 45%)` }}
    >
      {initials}
    </span>
  );
}

/** 32px inline micro-thumb for an asset-referencing event. Best-effort: if
 * the asset has no image variant the slot just stays empty. */
function MicroThumb({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/assets/${assetId}/url?variant=thumb`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d?.url) setUrl(d.url);
        else setErrored(true);
      })
      .catch(() => !cancelled && setErrored(true));
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  if (errored || !url) return null;
  return (
    <span className="h-8 w-8 shrink-0 overflow-hidden rounded bg-muted/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
    </span>
  );
}

interface ActivityEvent {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  actorUserName?: string | null;
  actorUserEmail?: string | null;
  kind: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

function summarize(ev: ActivityEvent): { text: string; assetId: string | null } {
  const payload = ev.payload ?? {};
  const assetId =
    (typeof payload.assetId === "string" ? payload.assetId : null) ??
    (ev.targetType === "asset" ? ev.targetId : null);
  const actor =
    ev.actorUserName?.trim() ||
    (ev.actorUserId ? ev.actorUserId.slice(0, 8) : "someone");
  switch (ev.kind) {
    case "comment.posted": {
      const excerpt = typeof payload.excerpt === "string" ? payload.excerpt : "";
      return { text: `${actor} commented: ${excerpt}`, assetId };
    }
    case "comment.deleted":
      return { text: `${actor} deleted a comment`, assetId };
    case "asset.uploaded":
      return { text: `${actor} uploaded a new asset`, assetId };
    case "asset.shared":
      return { text: `${actor} shared an asset with the workspace`, assetId };
    default:
      return { text: `${actor} · ${ev.kind}`, assetId };
  }
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function ActivitySection() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const fetchPage = useCallback(async (createdBefore: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    if (createdBefore) params.set("createdBefore", createdBefore);
    const res = await fetch(`/api/v1/workspace/activity?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { events: ActivityEvent[]; nextCursor: string | null };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchPage(null);
        if (cancelled) return;
        setEvents(data.events);
        setCursor(data.nextCursor);
        setDone(data.nextCursor === null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function handleLoadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(cursor);
      setEvents((prev) => [...prev, ...data.events]);
      setCursor(data.nextCursor);
      setDone(data.nextCursor === null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="updates-activity-heading" className="space-y-3">
      <h2
        id="updates-activity-heading"
        className="text-base font-semibold text-foreground"
      >
        Activity
      </h2>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No activity yet. Comments, uploads, and shares will show up here.
        </p>
      ) : (
        <ol className="space-y-3">
          {events.map((ev) => {
            const s = summarize(ev);
            return (
              <li key={ev.id} className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                <ActorAvatar
                  actorUserId={ev.actorUserId}
                  actorUserName={ev.actorUserName}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    {s.assetId ? (
                      <Link
                        href={`/app/library?asset=${s.assetId}`}
                        className="hover:underline"
                      >
                        {s.text}
                      </Link>
                    ) : (
                      s.text
                    )}
                  </p>
                  <span
                    className="text-xs text-muted-foreground"
                    title={new Date(ev.createdAt).toLocaleString()}
                  >
                    {formatRelative(ev.createdAt)}
                  </span>
                </div>
                {s.assetId ? <MicroThumb assetId={s.assetId} /> : null}
              </li>
            );
          })}
        </ol>
      )}

      {!loading && !done && events.length > 0 && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="rounded-md border border-input bg-background px-4 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </span>
            ) : (
              "Load more"
            )}
          </button>
        </div>
      )}
    </section>
  );
}
